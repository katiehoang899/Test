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
# mở http://localhost:3000
```

Biến môi trường:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng server |
| `HOST` | `127.0.0.1` | Địa chỉ lắng nghe (đặt `0.0.0.0` để máy khác truy cập) |
| `DATA_DIR` | `./data` | Thư mục lưu dữ liệu phiên |
| `ALLOW_PRIVATE` | _(tắt)_ | Đặt `1` để cho phép test các trang trong mạng nội bộ / localhost |

> Webcam chỉ hoạt động trong *secure context*: dùng `http://localhost` khi chạy trên máy mình, hoặc HTTPS nếu triển khai cho người khác truy cập.

## Cách dùng

1. Trang chủ: nhập link, tên người tham gia, bật/tắt eye tracking → **Bắt đầu theo dõi**.
2. Cho phép truy cập camera, làm **hiệu chỉnh 9 điểm** (nhìn vào chấm đỏ và click 5 lần mỗi chấm), sau đó nhìn chấm vàng 5 giây để đo độ chính xác. Nên đạt ≥ 70%; nếu thấp hãy hiệu chỉnh lại (ánh sáng đều, mặt nhìn thẳng camera, không di chuyển đầu).
3. Người dùng duyệt trang như bình thường. Click vào link sẽ được giữ trong công cụ để tiếp tục ghi. Có thể bật "Hiện điểm nhìn" để kiểm tra nhanh, hoặc "Hiệu chỉnh lại" bất cứ lúc nào.
4. Bấm **Kết thúc & xem báo cáo**.

## Cách hoạt động

```
Trình duyệt (track.html)                          Server Node (server.js)
┌──────────────────────────────────────┐          ┌──────────────────────────────┐
│ WebGazer (webcam → toạ độ màn hình)  │          │ /proxy?url=…                 │
│        │                             │          │  tải HTML trang đích,        │
│        ▼ trừ vị trí iframe + scroll  │          │  chèn <base href> để ảnh/CSS │
│ ┌──────────────────────────────────┐ │  HTML    │  tải thẳng từ site gốc       │
│ │ iframe /proxy?url=… (cùng origin)│◄├──────────┤                              │
│ │  → đọc được mousemove/click/     │ │          │ /api/sessions/…              │
│ │    scroll trực tiếp từ trang     │ │  events  │  lưu data/sessions/<id>.json │
│ └──────────────────────────────────┘ ├─────────►│  + <id>.ndjson (từng sự kiện)│
└──────────────────────────────────────┘          └──────────────────────────────┘
```

Trình duyệt không cho đọc tương tác bên trong iframe khác origin, nên server làm **proxy**: tải HTML của link, chèn thẻ `<base>` rồi trả về dưới cùng origin với công cụ. Nhờ vậy trang theo dõi gắn được listener vào tài liệu trong iframe. Toạ độ ánh mắt từ WebGazer (theo màn hình) được quy đổi sang **toạ độ tài liệu** (cộng vị trí cuộn), nên heatmap vẫn đúng chỗ khi người dùng cuộn trang.

Mỗi sự kiện lưu: `t` (ms từ lúc bắt đầu), `type`, `page`, `x/y` (toạ độ trong tài liệu), `vx/vy` (toạ độ trong khung nhìn), `vw/vh/dw/dh` (kích thước khung nhìn / tài liệu), `sx/sy` (vị trí cuộn), `el` (mô tả phần tử với click/focus).

### API

| Method | Đường dẫn | Mô tả |
|---|---|---|
| `POST` | `/api/sessions` | Tạo phiên `{ url, participant, eyeTracking }` |
| `GET` | `/api/sessions` | Danh sách phiên |
| `GET` | `/api/sessions/:id` | Thông tin phiên + toàn bộ sự kiện |
| `POST` | `/api/sessions/:id/events` | Gửi lô sự kiện `{ events: [...] }` |
| `PATCH` | `/api/sessions/:id` | Cập nhật `{ ended, calibration }` |
| `DELETE` | `/api/sessions/:id` | Xoá phiên |
| `GET` | `/api/sessions/:id/export?format=csv\|json` | Tải dữ liệu |

## Giới hạn cần biết

- **Độ chính xác của eye tracking qua webcam** thường khoảng 100–200px — đủ để biết người dùng chú ý vùng nào, không đủ để biết họ đọc từ nào.
- **Trang qua proxy có thể hiển thị khác bản gốc**: các SPA định tuyến theo `location.pathname`, trang gọi API cần cookie/CORS, trang yêu cầu đăng nhập hoặc chặn bot có thể không chạy đúng. Form gửi bằng POST bị chặn; nếu trang tự chuyển hướng ra ngoài proxy thì công cụ sẽ báo và ngừng ghi.
- Trang báo cáo tải lại link ở thời điểm xem, nên nội dung có thể đã thay đổi so với lúc ghi.
- **Bảo mật**: script của trang được test chạy cùng origin với công cụ (cần thiết để đọc tương tác), nên chỉ dùng công cụ với các trang bạn tin cậy và **không mở công cụ ra Internet công cộng**. Proxy mặc định chặn địa chỉ mạng nội bộ để tránh SSRF.
- **Quyền riêng tư**: hãy xin đồng ý của người tham gia trước khi bật camera. Không có hình ảnh nào rời khỏi trình duyệt — chỉ toạ độ ánh mắt được lưu.

## Kiểm thử

```bash
npm test
```

## Giấy phép

GPL-3.0-or-later (do sử dụng WebGazer.js, GPL-3.0).
