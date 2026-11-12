# AoE-MapCap Mobile

**[⬇ Tải app Android mới nhất (AoE-MapCap.apk)](https://github.com/trandinhnamuet/AoEMapCap-Mobile/releases/latest/download/AoE-MapCap.apk)**
· [Các phiên bản](https://github.com/trandinhnamuet/AoEMapCap-Mobile/releases)

App điện thoại xem lại trận Age of Empires 1 (Rise of Rome, bản AoE-HD) đã ghi bằng
[AoE-MapCap trên máy tính](https://github.com/trandinhnamuet/AoEMapCap): tua, đổi tầm nhìn từng đội, zoom, bảng chỉ số,
công nghệ, chạm vào unit / nhà để xem thông tin — như trình xem replay trên máy tính.

## Cách dùng

1. Trên máy tính: mở AoE-MapCap (từ v38), vào thẻ **Điện thoại**, bật "Cho điện thoại xem trận".
2. Trên điện thoại: mở app, bấm **Quét mã QR** và quét mã trên máy tính (chỉ cần một lần). Điện thoại dùng 4G hay Wi-Fi
   nào cũng được.
3. Chọn trận để xem. Trận đã mở được lưu trên điện thoại, xem lại được cả khi máy tính tắt.

Chưa cài app: quét mã bằng camera thường, trang web mở ra cũng xem được (cần Internet).

Cần Android 8 trở lên. Cài đặt: tải `AoE-MapCap.apk`, mở file, cho phép cài từ nguồn này.

## Hoạt động thế nào

- Máy tính gửi cho điện thoại **file ghi trận gốc** (`.aoerec`, khoảng 10–15 MB cho trận 20 phút). Điện thoại tự dựng
  trận trong nền và phát được ngay sau vài giây, phần sau dựng tiếp trong lúc xem.
- Lần đầu, máy tính gửi thêm **gói hình** (~23 MB) và **gói dữ liệu game** (~1,3 MB), lấy từ bộ cài game trên chính máy
  tính đó. Hai gói này lưu lại trên điện thoại, các trận sau không phải tải lại.
- Cùng Wi-Fi thì dữ liệu đi thẳng trong mạng nhà; khác mạng thì đi qua trạm chuyển tiếp trên Cloudflare (chỉ chuyển,
  không lưu).
- App **không** kèm hình hay dữ liệu của game (tài sản của Microsoft): mỗi người dùng dữ liệu từ bộ cài game của mình.

## Mã nguồn

| Thư mục | Nội dung |
|---|---|
| `web/` | trình xem (HTML / JavaScript, WebGL2): `js/viewer.js` phát và điều khiển, `js/gl.js` vẽ, `js/format.js` đọc dữ liệu trận, `js/hud.js` bảng chỉ số, `js/app.js` danh sách trận + kết nối máy tính, `js/rec/` bộ dựng trận từ file ghi gốc (chạy trong luồng nền) |
| `android/` | vỏ app Android (Java, một `WebView` chạy `web/`, quét mã QR) |
| `relay/` | trạm chuyển tiếp (Cloudflare Worker + Durable Object) và nơi đặt trang `web/` cho trình duyệt |
| `tools/` | `rec_build.mjs`: chạy bộ dựng bằng Node để so kết quả với bộ chuyển của bản máy tính |
| `notes/` | ghi chú từng bản (`v<N>.md`) |

Phát hành: tag `v<N>` -> GitHub Actions build, ký và đăng `AoE-MapCap.apk` (N là versionCode). Phía máy tính (gửi dữ
liệu, mã QR) nằm trong repo [AoEMapCap](https://github.com/trandinhnamuet/AoEMapCap) (`mapcap/mobile_server.py`,
`mapcap/relay_client.py`, `mapcap/webexport.py`).
