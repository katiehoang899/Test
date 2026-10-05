# Eye Tracking Tool

Công cụ web cho phép **nhập một đường link**, mở trang đó cho người dùng duyệt và **thu thập tương tác** của họ trên trang:

- 👁 **Ánh mắt** qua webcam (dùng [WebGazer.js](https://webgazer.cs.brown.edu/), chạy hoàn toàn trên trình duyệt, không gửi hình ảnh camera đi đâu)
- 🖱 Di chuột, click (kèm phần tử được click), focus vào ô nhập liệu (không ghi nội dung gõ)
- 📜 Cuộn trang, kích thước khung nhìn, các trang đã chuyển tới

Sau phiên test có trang **báo cáo**: heatmap ánh mắt / chuột / click, scanpath (chuỗi điểm dừng mắt), phát lại theo thời gian, thống kê và xuất JSON/CSV. Có thể gộp nhiều phiên cùng một link để xem heatmap tổng hợp.

## Chạy

Yêu cầu Node.js ≥ 18.

```bash
npm install
npm start
# mở http://localhost:3000/__et/
```

Biến môi trường:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng server |
| `HOST` | `127.0.0.1` | Địa chỉ lắng nghe (đặt `0.0.0.0` để máy khác truy cập) |
| `DATA_DIR` | `./data` | Thư mục lưu dữ liệu phiên |
| `ALLOW_PRIVATE` | _(tắt)_ | Đặt `1` để cho phép test các trang trong mạng nội bộ / localhost |
| `NODE_USE_ENV_PROXY` | _(tắt)_ | Đặt `1` nếu máy phải ra Internet qua proxy (`HTTPS_PROXY`) |

> Webcam chỉ hoạt động trong *secure context*: dùng `http://localhost` khi chạy trên máy mình, hoặc HTTPS nếu triển khai cho người khác truy cập.

## Ứng dụng macOS (.dmg)

Công cụ có thể chạy như một ứng dụng desktop (Electron): server chạy ngay bên trong app, không cần cài Node.js, dữ liệu lưu ở `~/Library/Application Support/Eye Tracking Tool/sessions` (menu **Dữ liệu → Mở thư mục dữ liệu**).

**Tải bản build sẵn:** mỗi lần push, GitHub Actions (workflow `Build macOS app (.dmg)`) build file `.dmg` trên máy macOS và đính kèm ở mục *Artifacts* của lần chạy:

- `Eye-Tracking-Tool-<version>-arm64.dmg` cho Mac chip Apple (M1/M2/M3/M4)
- `Eye-Tracking-Tool-<version>-x64.dmg` cho Mac chip Intel

**Tự build trên Mac:**

```bash
npm install
npm run app        # chạy thử ứng dụng desktop
npm run dist:mac   # tạo file .dmg trong thư mục dist/
```

**Lần mở đầu tiên:** app được ký ad-hoc, chưa ký bằng Apple Developer ID / notarize, nên macOS sẽ chặn với thông báo "không thể xác minh nhà phát triển". Kéo app vào *Applications*, sau đó:

- Chuột phải vào app → **Open** → **Open**, hoặc
- *System Settings → Privacy & Security* → kéo xuống, bấm **Open Anyway**, hoặc
- chạy `xattr -dr com.apple.quarantine "/Applications/Eye Tracking Tool.app"`

Khi bắt đầu phiên có eye tracking, macOS sẽ hỏi quyền **Camera**. Nếu lỡ từ chối, bật lại tại *System Settings → Privacy & Security → Camera*.

> Để phát hành cho nhiều người mà không bị cảnh báo, cần tài khoản Apple Developer: đặt `CSC_LINK`/`CSC_KEY_PASSWORD` (chứng chỉ Developer ID) và `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` để electron-builder ký và notarize, rồi bỏ `"identity": "-"` trong `package.json`.

## Cách dùng

1. Trang chủ: nhập link, tên người tham gia, bật/tắt eye tracking → **Bắt đầu theo dõi**.
2. Cho phép truy cập camera, làm **hiệu chỉnh 9 điểm** (nhìn vào chấm đỏ và click 5 lần mỗi chấm), sau đó nhìn chấm vàng 5 giây để đo độ chính xác. Nên đạt ≥ 70%; nếu thấp hãy hiệu chỉnh lại (ánh sáng đều, mặt nhìn thẳng camera, không di chuyển đầu).
3. Người dùng duyệt trang như bình thường. Click vào link sẽ được giữ trong công cụ để tiếp tục ghi. Có thể bật "Hiện điểm nhìn" để kiểm tra nhanh, hoặc "Hiệu chỉnh lại" bất cứ lúc nào.
4. Bấm **Kết thúc & xem báo cáo**.

## Cách hoạt động

```
http://localhost:3000
├── /__et/…            giao diện công cụ (trang chủ, theo dõi, báo cáo, API, WebGazer)
├── /__et/go?url=…     chọn site đích (lưu trong cookie) rồi chuyển tới đúng đường dẫn
└── mọi đường dẫn khác reverse proxy tới site đích, GIỮ NGUYÊN đường dẫn
                        (https://site.vn/san-pham?id=1 → http://localhost:3000/san-pham?id=1)
```

Trình duyệt không cho đọc tương tác bên trong iframe khác origin, nên server làm **reverse proxy**: trang đích được phục vụ dưới cùng origin với công cụ, nhờ vậy trang theo dõi gắn được listener vào tài liệu trong iframe. Vì đường dẫn được giữ nguyên, các SPA (Next.js, Nuxt, React Router…) vẫn định tuyến đúng, và các lệnh `fetch`/XHR tương đối của trang cũng đi qua proxy tới server gốc. Việc chuyển trang bằng `history.pushState` cũng được ghi thành lượt xem mới.

Toạ độ ánh mắt từ WebGazer (tính theo màn hình) được quy đổi sang **toạ độ trên tài liệu** (cộng thêm vị trí cuộn), nên heatmap vẫn đúng chỗ khi người dùng cuộn trang.

Mỗi sự kiện lưu: `t` (ms từ lúc bắt đầu), `type`, `page`, `x/y` (toạ độ trong tài liệu), `vx/vy` (toạ độ trong khung nhìn), `vw/vh/dw/dh` (kích thước khung nhìn / tài liệu), `sx/sy` (vị trí cuộn), `el` (mô tả phần tử với click/focus). Dữ liệu nằm ở `data/sessions/<id>.json` (thông tin phiên) và `<id>.ndjson` (từng sự kiện).

### API

| Method | Đường dẫn | Mô tả |
|---|---|---|
| `POST` | `/__et/api/sessions` | Tạo phiên `{ url, participant, eyeTracking }` |
| `GET` | `/__et/api/sessions` | Danh sách phiên |
| `GET` | `/__et/api/sessions/:id` | Thông tin phiên + toàn bộ sự kiện |
| `POST` | `/__et/api/sessions/:id/events` | Gửi lô sự kiện `{ events: [...] }` |
| `PATCH` | `/__et/api/sessions/:id` | Cập nhật `{ ended, calibration }` |
| `DELETE` | `/__et/api/sessions/:id` | Xoá phiên |
| `GET` | `/__et/api/sessions/:id/export?format=csv\|json` | Tải dữ liệu |

## Giới hạn cần biết

- **Độ chính xác của eye tracking qua webcam** thường khoảng 100–200px — đủ để biết người dùng chú ý vùng nào, không đủ để biết họ đọc từ nào.
- **Trang qua proxy có thể hiển thị khác bản gốc**: trang gọi API bằng URL tuyệt đối tới domain khác cần CORS, trang có tường lửa chống bot (Cloudflare challenge…) hoặc đăng nhập bằng bên thứ ba có thể không chạy đúng. Service worker của trang bị tắt. Mỗi trình duyệt chỉ theo dõi một site đích tại một thời điểm (lưu trong cookie).
- Trang báo cáo tải lại link ở thời điểm xem, nên nội dung có thể đã thay đổi so với lúc ghi.
- **Bảo mật**: script của trang được test chạy cùng origin với công cụ (cần thiết để đọc tương tác), nên chỉ dùng công cụ với các trang bạn tin cậy và **không mở công cụ ra Internet công cộng**. Proxy mặc định chặn địa chỉ mạng nội bộ để tránh SSRF.
- **Quyền riêng tư**: hãy xin đồng ý của người tham gia trước khi bật camera. Không có hình ảnh nào rời khỏi trình duyệt — chỉ toạ độ ánh mắt được lưu.

## Kiểm thử

```bash
npm test
```

## Giấy phép

GPL-3.0-or-later (do sử dụng WebGazer.js, GPL-3.0).
