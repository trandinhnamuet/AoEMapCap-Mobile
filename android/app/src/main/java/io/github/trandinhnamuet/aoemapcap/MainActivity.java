package io.github.trandinhnamuet.aoemapcap;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Trang web/ (đóng gói trong assets) chạy trong WebView ở https://appassets.androidplatform.net/app/.
 *
 * Máy chủ AoE-MapCap trên máy tính chỉ có http trong mạng nhà, nên trang không gọi thẳng nó (mixed content, CORS):
 * trang gọi /pc/&lt;ip:cổng&gt;/&lt;mã&gt;/... cùng nguồn, app tự tải http://&lt;ip:cổng&gt;/&lt;mã&gt;/... rồi trả về.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/app/index.html";

    /** Bản mới chỉ được tải từ trang phát hành của chính app (file APK còn phải cùng tên gói, cùng chữ ký, số bản lớn hơn). */
    private static final String UPDATE_FROM = "https://github.com/trandinhnamuet/AoEMapCap-Mobile/releases/download/";
    private static final String UPDATE_FILE = "update.apk";
    private static WeakReference<MainActivity> current = new WeakReference<>(null);
    private volatile boolean updating;

    private WebView web;
    private WebViewAssetLoader assets;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        current = new WeakReference<>(this);
        if (!updating) new File(getCacheDir(), UPDATE_FILE).delete();      // file cài của lần cập nhật trước
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0F1114);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        assets = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/app/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                String path = u.getEncodedPath();
                if (path != null && path.startsWith("/pc/")) return proxy(u, req.getMethod());
                return assets.shouldInterceptRequest(u);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                // liên kết ngoài mở bằng trình duyệt
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "AoEApp");

        String pair = pairUrl(getIntent());
        if (pair != null || state == null || web.restoreState(state) == null) web.loadUrl(pair != null ? pair : START);
    }

    /** Nút "Mở trong app" trên trình duyệt -> trang ?pair=...:
     *  aoemapcap://pair?r=<phòng trên trạm chuyển tiếp>&l=<ip:cổng/mã> (từ mobile-v3) -> ?pair=r=...&l=...;
     *  aoemapcap://pair?a=192.168.1.5:8765/abc123 (trang của máy tính, v14) -> ?pair=192.168.1.5:8765/abc123. */
    private static String pairUrl(Intent intent) {
        Uri d = intent == null ? null : intent.getData();
        if (d == null || !"aoemapcap".equals(d.getScheme()) || !"pair".equals(d.getHost())) return null;
        String a = d.getQueryParameter("a");
        if (a == null && d.getQueryParameter("r") != null) a = d.getEncodedQuery();
        return a == null ? null : START + "?pair=" + Uri.encode(a);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String pair = pairUrl(intent);
        if (pair != null) web.loadUrl(pair);
    }

    /** Hàm cho trang web gọi: window.AoEApp.scanQr() / versionCode(). */
    private class Bridge {
        @JavascriptInterface
        public void scanQr() {
            runOnUiThread(MainActivity.this::scanQr);
        }

        /** Tên máy (hãng + dòng máy) để trang Điện thoại của AoE-MapCap trên máy tính hiện máy nào đã liên kết. */
        @JavascriptInterface
        public String deviceName() {
            String m = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER, d = Build.MODEL == null ? "" : Build.MODEL;
            return d.toLowerCase().startsWith(m.toLowerCase()) ? d : (m + " " + d).trim();
        }

        @JavascriptInterface
        public int versionCode() {
            return MainActivity.this.versionCode();
        }

        /** Cập nhật một chạm (từ v12): app tự tải APK bản mới rồi cài đè. Tiến độ báo về trang qua onUpdateState(...).
         *  Trả false nếu địa chỉ không phải trang phát hành của app. */
        @JavascriptInterface
        public boolean update(String url) {
            if (url == null || !url.startsWith(UPDATE_FROM)) return false;
            if (updating) return true;
            updating = true;
            new Thread(() -> runUpdate(url), "update").start();
            return true;
        }
    }

    private int versionCode() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            return 0;
        }
    }

    // ---- cập nhật một chạm ---------------------------------------------------------------------------------------
    // Tải APK về bộ nhớ đệm của app -> kiểm tra (đúng gói, số bản lớn hơn) -> giao cho trình cài của Android
    // (PackageInstaller). Android tự kiểm chữ ký: file không ký bằng khoá của app thì không cài được.
    // Android 12+: app tự cập nhật chính nó không cần hỏi lại (USER_ACTION_NOT_REQUIRED) sau khi người dùng đã cho phép
    // "cài ứng dụng không rõ nguồn" cho app một lần; máy cũ hơn hiện một hộp xác nhận của hệ thống.
    private void updateState(String state, double a, double b, String msg) {
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript("window.onUpdateState && onUpdateState(" + js(state) + ", " + a + ", " + b
                    + ", " + js(msg) + ")", null);
        });
    }

    private void runUpdate(String url) {
        File f = new File(getCacheDir(), UPDATE_FILE);
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);
            c.setRequestProperty("Accept-Encoding", "identity");
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("trang phát hành trả mã " + code);
            long total = c.getContentLengthLong(), got = 0, last = 0;
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(f)) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) {
                    out.write(buf, 0, n);
                    got += n;
                    long now = System.currentTimeMillis();
                    if (now - last > 200) { last = now; updateState("download", got, total, null); }
                }
            } finally {
                c.disconnect();
            }
            if (total > 0 && got != total) throw new IOException("tải chưa đủ file");
            PackageInfo pi = getPackageManager().getPackageArchiveInfo(f.getPath(), 0);
            if (pi == null || !getPackageName().equals(pi.packageName)) throw new IOException("file tải về không phải app này");
            long ver = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            if (ver <= versionCode()) throw new IOException("file tải về không mới hơn bản đang dùng");
            updateState("install", got, got, null);

            PackageInstaller inst = getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            p.setAppPackageName(getPackageName());
            p.setSize(f.length());
            if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            int id = inst.createSession(p);
            try (PackageInstaller.Session s = inst.openSession(id)) {
                try (OutputStream out = s.openWrite("base.apk", 0, f.length()); InputStream in = new FileInputStream(f)) {
                    byte[] buf = new byte[1 << 16];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                    s.fsync(out);
                }
                Intent done = new Intent(this, UpdateReceiver.class);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                s.commit(PendingIntent.getBroadcast(this, id, done, flags).getIntentSender());
            }
            // cài xong Android đóng app (bản mới thay bản cũ); lỗi / cần xác nhận thì UpdateReceiver báo
        } catch (Exception e) {
            updating = false;
            f.delete();
            updateState("error", 0, 0, e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }

    /** Kết quả từ trình cài của Android: cần người dùng xác nhận -> mở hộp xác nhận; lỗi / huỷ -> báo về trang. */
    public static class UpdateReceiver extends BroadcastReceiver {
        @Override
        @SuppressWarnings("deprecation")
        public void onReceive(Context ctx, Intent intent) {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            MainActivity a = current.get();
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm == null) return;
                try {
                    if (a != null) { a.startActivity(confirm); a.updateState("confirm", 0, 0, null); }
                    else ctx.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (RuntimeException e) {
                    if (a != null) { a.updating = false; a.updateState("error", 0, 0, e.toString()); }
                }
                return;
            }
            if (a == null) return;
            a.updating = false;
            if (status == PackageInstaller.STATUS_SUCCESS) a.updateState("done", 0, 0, null);
            else if (status == PackageInstaller.STATUS_FAILURE_ABORTED) a.updateState("cancel", 0, 0, null);
            else a.updateState("error", 0, 0, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
        }
    }

    private void scanQr() {
        try {
            GmsBarcodeScannerOptions opts = new GmsBarcodeScannerOptions.Builder()
                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                    .build();
            GmsBarcodeScanning.getClient(this, opts).startScan()
                    .addOnSuccessListener(b -> qrResult(b.getRawValue(), null))
                    .addOnCanceledListener(() -> qrResult(null, null))
                    .addOnFailureListener(e -> qrResult(null, e.getMessage() != null ? e.getMessage() : e.toString()));
        } catch (RuntimeException e) {
            qrResult(null, e.toString());          // máy không có Google Play Services
        }
    }

    private void qrResult(String text, String error) {
        web.evaluateJavascript("window.onQrResult && onQrResult(" + js(text) + ", " + js(error) + ")", null);
    }

    private static String js(String s) {
        return s == null ? "null" : JSONObject.quote(s);
    }

    private static WebResourceResponse proxy(Uri u, String method) {
        if (!"GET".equals(method)) return error(405, "Method Not Allowed", "chỉ hỗ trợ GET");
        String query = u.getEncodedQuery();
        String target = "http://" + u.getEncodedPath().substring(4) + (query != null ? "?" + query : "");
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(target).openConnection();
            c.setConnectTimeout(5000);
            c.setReadTimeout(60000);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("Accept-Encoding", "identity");    // để Content-Length đúng cho thanh tiến độ
            int code = c.getResponseCode();
            if (code < 200 || (code >= 300 && code < 400)) {
                c.disconnect();
                return error(502, "Bad Gateway", "máy tính trả mã " + code);
            }
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in == null) in = new ByteArrayInputStream(new byte[0]);
            in = new java.io.BufferedInputStream(in, 1 << 18);     // WebView đọc từng mẩu nhỏ: đệm 256 KB cho file hàng chục MB
            String type = c.getContentType();
            String mime = type == null ? "application/octet-stream" : type.split(";")[0].trim();
            Map<String, String> headers = new HashMap<>();
            long len = c.getContentLengthLong();
            if (len >= 0) headers.put("Content-Length", Long.toString(len));
            headers.put("Cache-Control", "no-store");
            String reason = c.getResponseMessage();
            if (reason == null || reason.isEmpty()) reason = code >= 400 ? "Error" : "OK";
            return new WebResourceResponse(mime, null, code, reason, headers, in);
        } catch (IOException | IllegalArgumentException e) {
            return error(502, "Bad Gateway", "không kết nối được máy tính: " + e.getMessage());
        }
    }

    private static WebResourceResponse error(int code, String reason, String text) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason, new HashMap<>(),
                new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)));
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
