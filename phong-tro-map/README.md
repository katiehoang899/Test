# Phòng trọ Map

Công cụ xem **tất cả tin cho thuê phòng trọ** trên [Nhà Tốt](https://www.nhatot.com/thue-phong-tro) (Chợ Tốt) dạng **danh sách** và **bản đồ**, giữ các bộ lọc của trang.

## Tính năng

- **Bộ lọc giống nhatot.com**, gửi đúng tham số của Nhà Tốt lên API:
  | Bộ lọc | Tham số |
  |---|---|
  | Loại tin: Cho thuê / Cần thuê / Tất cả | `st=u` / `st=h` / `st=u,h` |
  | Tỉnh / thành → Quận / huyện → Phường / xã | `region_v2`, `area_v2`, `ward` |
  | Giá thuê (mốc có sẵn hoặc tự nhập, đơn vị triệu) | `price=min-max` |
  | Diện tích (mốc có sẵn hoặc tự nhập, m²) | `size=min-max` |
  | Tình trạng nội thất (chọn nhiều) | `furnishing_rent=1,2,…` |
  | Đăng bởi: Cá nhân / Môi giới | `f=p` / `f=c` |
  | Từ khoá | `q` |
  | Sắp xếp: mới nhất, giá tăng / giảm, diện tích, giá / m² | `sp` + sắp xếp lại trên trình duyệt |
- **Bản đồ** (OpenStreetMap + Leaflet): các tin được gom cụm khi thu nhỏ. Bấm vào ghim để xem ảnh, giá, diện tích, địa chỉ và link tới tin gốc. Bấm một tin trong danh sách thì bản đồ bay tới đúng ghim của tin đó.
  - 🟢 ghim xanh: tin có toạ độ do người đăng chọn.
  - ⚪ ghim xám: tin **không có toạ độ** được đặt **gần đúng** theo phường (hoặc quận nếu không tìm thấy phường), dùng geocode của OpenStreetMap Nominatim. Có thể tắt bằng ô *Định vị gần đúng tin thiếu toạ độ*.
- **3 chế độ xem**: Danh sách, Chia đôi (danh sách + bản đồ), Bản đồ. Trên điện thoại có Danh sách và Bản đồ.
- **Tải tất cả**: tự lấy hết các trang kết quả (tối đa 5.000 tin mỗi lần lọc), bấm lần nữa để dừng. Cuộn xuống cuối danh sách cũng tự tải thêm.
- **Chỉ tin trong khung bản đồ**: kéo / phóng bản đồ tới khu vực muốn ở, danh sách chỉ còn các tin trong khung đó.
- Bộ lọc được lưu trên URL (`?region_v2=13000&price=2000000-4000000…`), nên có thể gửi link cho người khác.

## Chạy

Yêu cầu Node.js ≥ 18, không cần cài thêm package.

```bash
cd phong-tro-map
npm start
# mở http://localhost:3100
```

Biến môi trường (không bắt buộc):

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3100` | Cổng web |
| `CHOTOT_GATEWAY` | `https://gateway.chotot.com` | API của Chợ Tốt |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org` | Dịch vụ geocode cho tin thiếu toạ độ |
| `DATA_DIR` | `./data` | Nơi lưu cache geocode (`geocode-cache.json`) |

Chạy test: `npm test`.

## Cách hoạt động

`server.js` là proxy nhỏ tới API công khai mà chính nhatot.com dùng (`gateway.chotot.com/v1/public/ad-listing`, danh mục `cg=1050` = phòng trọ). Trình duyệt không gọi thẳng được API này vì bị chặn CORS. Server cache kết quả 1 phút, danh sách khu vực 1 ngày. Geocode chạy tuần tự 1 request/giây đúng [chính sách của Nominatim](https://operations.osmfoundation.org/policies/nominatim/) và lưu ra file, nên lần sau mở lại không phải định vị lại.

Trình duyệt còn **lọc lại** các tin đã tải theo đúng bộ lọc đang chọn (giá, diện tích, khu vực, nội thất, người đăng, từ khoá không dấu). Nhờ vậy nếu API bỏ qua một tham số thì danh sách vẫn đúng bộ lọc, chỉ ít tin hơn.

## Lưu ý

- API của Chợ Tốt là API nội bộ, không có tài liệu chính thức và có thể đổi bất cứ lúc nào. Mã giá trị một vài bộ lọc (`furnishing_rent`, `sp`) được lấy theo URL của nhatot.com và gom ở đầu `public/filters.js` / `public/index.html`. Nếu Nhà Tốt đổi mã, chỉ cần sửa ở đó.
- Công cụ dùng cho mục đích cá nhân (tìm phòng). Tôn trọng [điều khoản sử dụng của Chợ Tốt](https://trogiup.chotot.com/), không dùng để thu thập dữ liệu hàng loạt. Nút *Tải tất cả* có giới hạn và server có cache để tránh gọi API quá nhiều.
- Ảnh và nội dung tin thuộc về người đăng / Chợ Tốt. Bấm vào tin để xem đầy đủ và liên hệ trên nhatot.com.
