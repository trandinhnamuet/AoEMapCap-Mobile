// Trạm chuyển tiếp giữa AoE-MapCap trên máy tính và điện thoại khi hai máy không cùng mạng.
//
// - WebSocket /r/<phòng>?role=pc | phone. Mỗi phòng (mã 24 ký tự bí mật, chỉ có trong mã QR của máy tính) là một
//   Durable Object. Máy tính giữ một kết nối thường trực; Durable Object ngủ đông khi không có dữ liệu (không tính
//   phí), "ping" được trả "pong" mà không đánh thức.
// - Không lưu gì: dữ liệu (danh sách trận, trận, gói hình game từ bộ cài của chính người dùng) chỉ đi qua từ máy
//   tính sang điện thoại của họ. Luồng do điện thoại cấp "tín dụng" từng phần nên trạm chỉ giữ tạm vài trăm KB.
// - Khung tin:
//     điện thoại -> trạm: chữ JSON {r, p} (yêu cầu), {r, k} (thêm tín dụng), {r, x} (huỷ); trạm thêm c (số kết nối)
//       rồi chuyển cho máy tính. Máy tính chưa kết nối: trạm trả {r, err: "pc-offline"}.
//     máy tính -> trạm: nhị phân [u32 c][phần còn lại]; trạm cắt 4 byte đầu, chuyển phần còn lại cho điện thoại c.
//     trạm -> điện thoại: {hello, pc} lúc vào, {pc: "on" | "off"} khi máy tính kết nối / rớt.
//     trạm -> máy tính: {c, closed: 1} khi điện thoại c rời đi (máy tính dừng các luồng của nó).
// - Các đường còn lại: trang web/ (Static Assets), để quét QR bằng camera thường xem được trên trình duyệt.
import { DurableObject } from "cloudflare:workers";

const ROOM = /^\/r\/([a-z2-9]{20,40})$/;

export default {
  async fetch(req, env) {
    const m = ROOM.exec(new URL(req.url).pathname);
    if (m) return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
    return env.ASSETS.fetch(req);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("cần WebSocket", { status: 426 });
    const role = new URL(req.url).searchParams.get("role");
    if (role !== "pc" && role !== "phone") return new Response("role = pc | phone", { status: 400 });
    const [client, server] = Object.values(new WebSocketPair());
    if (role === "pc") {
      for (const old of this.ctx.getWebSockets("pc")) {
        try { old.close(4000, "máy tính khác đã kết nối"); } catch { /* đã đóng */ }
      }
      this.ctx.acceptWebSocket(server, ["pc"]);
      server.serializeAttachment({ t: Date.now() });
      this.toPhones({ pc: "on" });
    } else {
      const c = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
      this.ctx.acceptWebSocket(server, ["phone", "c" + c]);
      server.serializeAttachment({ c });
      server.send(JSON.stringify({ hello: 1, pc: this.pc() !== null }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // kết nối máy tính mới nhất còn mở (kết nối cũ vừa bị thay có thể chưa đóng hẳn)
  pc(except) {
    let best = null, bt = -1;
    for (const ws of this.ctx.getWebSockets("pc")) {
      if (ws === except || ws.readyState !== 1) continue;
      const t = (ws.deserializeAttachment() || {}).t || 0;
      if (t > bt) { best = ws; bt = t; }
    }
    return best;
  }

  phone(c) {
    return this.ctx.getWebSockets("c" + c)[0] || null;
  }

  toPhones(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets("phone")) {
      try { ws.send(s); } catch { /* đang đóng */ }
    }
  }

  webSocketMessage(ws, msg) {
    if (this.ctx.getTags(ws).includes("pc")) {
      if (typeof msg === "string" || msg.byteLength < 4) return;
      const to = this.phone(new DataView(msg).getUint32(0, true));
      if (to) {
        try { to.send(msg.slice(4)); } catch { /* điện thoại vừa rời */ }
      }
      return;
    }
    if (typeof msg !== "string" || msg.length > 4096) return;
    let j;
    try { j = JSON.parse(msg); } catch { return; }
    const pc = this.pc();
    if (!pc) {
      if (j.p !== undefined) ws.send(JSON.stringify({ r: j.r, err: "pc-offline" }));
      return;
    }
    j.c = ws.deserializeAttachment().c;
    pc.send(JSON.stringify(j));
  }

  webSocketClose(ws, code) {
    this.gone(ws);
    try { ws.close(code === 1005 ? 1000 : code, "đóng"); } catch { /* đã đóng */ }
  }

  webSocketError(ws) {
    this.gone(ws);
  }

  gone(ws) {
    if (this.ctx.getTags(ws).includes("pc")) {
      if (!this.pc(ws)) this.toPhones({ pc: "off" });
      return;
    }
    const pc = this.pc(ws);
    const a = ws.deserializeAttachment();
    if (pc && a) {
      try { pc.send(JSON.stringify({ c: a.c, closed: 1 })); } catch { /* máy tính đang đóng */ }
    }
  }
}
