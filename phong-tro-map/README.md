# Phòng trọ Map

Công cụ xem **tất cả tin cho thuê phòng trọ** trên [Nhà Tốt](https://www.nhatot.com/thue-phong-tro) (Chợ Tốt) dạng **danh sách** và **bản đồ**, giữ các bộ lọc của trang.

## Tính năng

- **Bộ lọc giống nhatot.com**, gửi đúng tham số của Nhà Tốt lên API:
  | Bộ lọc | Tham số |
  |---|---|
  | Loại tin: Cho thuê / Cần thuê / Tất cả | `st=u` / `st=h` / `st=u,h` |
  | Tỉnh / thành → Quận / huyện → Phường / xã (**chọn nhiều** quận và phường) | `region_v2`, `area_v2`, `ward` |
  | Giá thuê (mốc có sẵn hoặc tự nhập, đơn vị triệu) | `price=min-max` |
  | Diện tích (mốc có sẵn hoặc tự nhập, m²) | `size=min-max` |
  | Tình trạng nội thất (chọn nhiều) | `furnishing_rent=1,2,…` |
  | Đăng bởi: Cá nhân / Môi giới | `f=p` / `f=c` |
  | Từ khoá | `q` |
  | Sắp xếp: mới nhất, giá tăng / giảm, diện tích, giá / m² | `sp` + sắp xếp lại trên trình duyệt |
- **Chọn nhiều quận / phường**: tick nhiều quận trong *Quận / huyện* (có ô tìm nhanh), rồi bấm *Áp dụng* hoặc bấm ra ngoài. *Phường / xã* liệt kê phường theo từng quận đã chọn. Quận nào có tick phường thì chỉ lấy các phường đó, quận nào không tick phường thì lấy cả quận. API Nhà Tốt chỉ nhận một quận / phường mỗi lần, nên tool gọi riêng cho từng nơi (tối đa 4 nơi song song) rồi gộp kết quả.
- **Loại trừ từ khoá** (`nq`): nhập các từ khoá cách nhau bằng dấu phẩy, ví dụ `Giá từ 5, ở ghép`. Tin có chứa một trong các từ khoá đó (trong tiêu đề hoặc nội dung, không phân biệt hoa thường hay có dấu) sẽ bị ẩn. Có sẵn gợi ý: *giá từ, chỉ từ, ở ghép, ký túc xá, sleepbox, chung chủ*.
- **Loại tin sale trọ** (`nosale=1`): ẩn tin của người dẫn khách, tức là một tin đăng cho nhiều phòng. Tin bị coi là sale nếu nội dung có:
  - "giá từ", "chỉ từ", "giá dao động", "từ 3tr…";
  - **khoảng giá**: `3tr - 5tr`, `3 - 5 triệu`, `2tr5 ~ 4tr`, `từ 3 đến 5 triệu`, `3.500.000 - 5.000.000đ`;
  - "nhiều phòng", "còn nhiều phòng", "đa dạng mức giá", "hệ thống phòng / chuỗi CHDV";
  - "hỗ trợ tìm phòng", "dẫn xem phòng", "xem phòng miễn phí", "list phòng", "giỏ hàng", "ký gửi", chữ "sale".

  Giá điện nước (`3.5k`), kích thước (`rộng 3 - 4m`, `20 - 25m2`), giờ giấc (`5h - 23h`), số người ở (`2 - 3 người`) **không** bị tính là khoảng giá. Khi bộ lọc này đang tắt, tin có dấu hiệu sale vẫn được gắn nhãn *Có thể là sale* (rê chuột để xem lý do).
  - Thanh trạng thái cho biết đã ẩn bao nhiêu tin. Tick **Hiện tin bị ẩn** để xem lại các tin đó (làm mờ, kèm lý do) và kiểm tra xem bộ lọc có ẩn nhầm không.
  - Hai bộ lọc này chạy trên trình duyệt vì API Nhà Tốt không hỗ trợ, nên bật/tắt có hiệu lực ngay, không cần tải lại. Nếu bộ lọc ẩn gần hết tin đã tải, tool tự tải thêm (tối đa 8 trang mỗi lần) cho đủ tin để xem.
- **Bản đồ** (OpenStreetMap + Leaflet): các tin được gom cụm khi thu nhỏ. Bấm vào ghim để xem ảnh, giá, diện tích, địa chỉ và link tới tin gốc. Bấm một tin trong danh sách thì bản đồ bay tới đúng ghim của tin đó.
  - 🟢 ghim xanh: tin có toạ độ do người đăng chọn.
  - ⚪ ghim xám: tin **không có toạ độ** được đặt **gần đúng** theo phường (hoặc quận nếu không tìm thấy phường), dùng geocode của OpenStreetMap Nominatim. Có thể tắt bằng ô *Định vị gần đúng tin thiếu toạ độ*.
- **Google Maps / Street View**: popup của mỗi tin có nút *📍 Google Maps* (mở Google Maps tại vị trí tin) và *🚶 Street View* (mở thẳng khung Street View ở đó). Click vào **bất kỳ điểm nào** trên bản đồ cũng hiện toạ độ và hai nút này. Với tin vị trí gần đúng, Google Maps tìm theo địa chỉ của tin, còn Street View mở ở khu vực phường.
- **Xem trước Street View ngay trong popup** (tin có toạ độ): ô ảnh nhỏ hiện ảnh Street View mới nhất gần vị trí tin, kèm **ngày chụp** (ví dụ *📷 Tháng 11/2024*) và khoảng cách từ chỗ chụp tới vị trí tin. Camera tự quay về phía vị trí tin. Bấm vào ảnh để mở đúng ảnh đó trên Google Maps. Tính năng này cần Google Maps API key (xem bên dưới). Chưa có key thì popup hiện ô để dán key vào.
- **3 chế độ xem**: Danh sách, Chia đôi (danh sách + bản đồ), Bản đồ. Trên điện thoại có Danh sách và Bản đồ.
- **Tải tất cả**: tự lấy hết các trang kết quả (tối đa 5.000 tin mỗi lần lọc), bấm lần nữa để dừng. Cuộn xuống cuối danh sách cũng tự tải thêm.
- **Chỉ tin trong khung bản đồ**: kéo / phóng bản đồ tới khu vực muốn ở, danh sách chỉ còn các tin trong khung đó.
- Bộ lọc được lưu trên URL (`?region_v2=13000&price=2000000-4000000…`), nên có thể gửi link cho người khác.

## Chạy thử trên máy (localhost)

### Bước 1. Cài Node.js (chỉ làm một lần)

Tải bản **LTS** tại [nodejs.org](https://nodejs.org/) rồi cài như phần mềm bình thường. Cần bản 18 trở lên. Kiểm tra bằng Terminal (macOS) hoặc Command Prompt (Windows):

```bash
node -v   # ví dụ v22.x.x
```

### Bước 2. Lấy code về máy

Chọn **một** trong hai cách:

- **Tải ZIP (không cần git):** mở nhánh [`claude/affectionate-hamilton-dbu4od`](https://github.com/katiehoang899/Test/tree/claude/affectionate-hamilton-dbu4od), bấm nút xanh **Code → Download ZIP**, rồi giải nén.
- **Dùng git:**
  ```bash
  git clone -b claude/affectionate-hamilton-dbu4od https://github.com/katiehoang899/Test.git
  ```

### Bước 3. Chạy

- **macOS:** mở thư mục `phong-tro-map`, **bấm đúp `start.command`**. Lần đầu macOS có thể chặn ("không xác định được nhà phát triển"): **chuột phải → Open → Open**. Nếu báo không có quyền chạy (thường gặp khi tải ZIP), mở Terminal và chạy lệnh dưới đây một lần:
  ```bash
  chmod +x ~/Downloads/Test-claude-affectionate-hamilton-dbu4od/phong-tro-map/start.command
  ```
  (đổi đường dẫn cho đúng chỗ bạn giải nén; có thể kéo file vào cửa sổ Terminal để điền đường dẫn).
- **Windows:** mở thư mục `phong-tro-map`, **bấm đúp `start.bat`**. Nếu Windows hiện "Windows protected your PC": **More info → Run anyway**.
- **Hoặc dùng lệnh** (mọi hệ điều hành):
  ```bash
  cd phong-tro-map
  npm start
  ```

Trình duyệt tự mở **http://localhost:3100** (nếu không, tự gõ địa chỉ này vào trình duyệt). Không cần `npm install`, vì tool không dùng package ngoài.

### Bước 4. Dùng thử

1. Chọn **Tp Hồ Chí Minh** (hoặc tỉnh khác) → **Quận / huyện** → tick vài quận → **Áp dụng**.
2. Chọn **Giá thuê**, bật **Loại tin sale trọ**, thêm **Loại trừ từ khoá** nếu cần.
3. Bấm một tin trong danh sách: bản đồ bay tới ghim của tin đó. Popup có ảnh Street View (cần API key, xem bên dưới) và nút **Google Maps / Street View**.
4. Bấm **Tải tất cả** để lấy hết tin theo bộ lọc.

### Tắt

Đóng cửa sổ Terminal / Command Prompt đang chạy, hoặc bấm **Ctrl + C** trong đó.

### Gặp lỗi?

| Hiện tượng | Cách xử lý |
|---|---|
| `Cổng 3100 đang được dùng` | Tool đã chạy sẵn: mở http://localhost:3100. Hoặc chạy ở cổng khác: `PORT=3200 npm start` (Windows: `set PORT=3200` rồi `npm start`) |
| `node: command not found` / `'node' is not recognized` | Chưa cài Node.js hoặc chưa mở lại Terminal sau khi cài |
| Danh sách báo *Không tải được tin: Upstream 403 / 429…* | Chợ Tốt chặn hoặc giới hạn tạm thời: đợi vài phút rồi tải lại trang. Nếu lỗi kéo dài, có thể API của Chợ Tốt đã đổi, hãy báo lại kèm thông báo lỗi |
| Bản đồ trống, không có nền | Máy không vào được `tile.openstreetmap.org` hoặc `cdnjs.cloudflare.com` (mạng công ty / VPN chặn) |
| Danh sách khu vực chỉ có vài tỉnh | API khu vực của Chợ Tốt không trả về; tool tự lấy tên tỉnh / quận từ các tin đã tải, càng tải nhiều càng đủ |

Mặc định tool chỉ mở được trên chính máy đang chạy. Muốn mở từ điện thoại cùng mạng Wi-Fi: chạy `HOST=0.0.0.0 npm start` rồi vào `http://<IP-máy-tính>:3100` (lúc này người khác cùng mạng cũng mở được, kể cả ô nhập API key).

Biến môi trường (không bắt buộc):

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3100` | Cổng web |
| `HOST` | `127.0.0.1` | Địa chỉ nghe. `0.0.0.0` để máy khác trong mạng LAN mở được |
| `CHOTOT_GATEWAY` | `https://gateway.chotot.com` | API của Chợ Tốt |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org` | Dịch vụ geocode cho tin thiếu toạ độ |
| `DATA_DIR` | `./data` | Nơi lưu cache geocode (`geocode-cache.json`) |

| `GOOGLE_MAPS_API_KEY` | (trống) | Key cho ô xem trước Street View. Cũng có thể dán key ngay trong popup trên bản đồ, key được lưu ở `DATA_DIR/config.json` |

Chạy test: `npm test`.

### Lấy Google Maps API key (cho ô xem trước Street View)

1. Vào [Google Cloud Console](https://console.cloud.google.com/), tạo project (cần gắn tài khoản thanh toán, Google có hạn mức dùng miễn phí hằng tháng).
2. *APIs & Services → Library*, bật **Street View Static API**.
3. *APIs & Services → Credentials → Create credentials → API key*. Nên giới hạn key chỉ dùng cho *Street View Static API*.
4. Mở một ghim trên bản đồ, dán key vào ô trong popup rồi bấm **Lưu** (hoặc chạy với `GOOGLE_MAPS_API_KEY=… npm start`).

Mỗi lần mở popup tốn 1 lượt tra metadata (Google không tính phí) và 1 lượt tải ảnh. Ảnh được lưu trong `DATA_DIR/streetview`, nên mở lại tin cũ không tốn thêm lượt. Key chỉ nằm trên server, trang web không đọc được. Không có key thì hai nút *Google Maps / Street View* vẫn dùng bình thường.

## Cách hoạt động

`server.js` là proxy nhỏ tới API công khai mà chính nhatot.com dùng (`gateway.chotot.com/v1/public/ad-listing`, danh mục `cg=1050` = phòng trọ). Trình duyệt không gọi thẳng được API này vì bị chặn CORS. Server cache kết quả 1 phút, danh sách khu vực 1 ngày. Geocode chạy tuần tự 1 request/giây đúng [chính sách của Nominatim](https://operations.osmfoundation.org/policies/nominatim/) và lưu ra file, nên lần sau mở lại không phải định vị lại.

Trình duyệt còn **lọc lại** các tin đã tải theo đúng bộ lọc đang chọn (giá, diện tích, khu vực, nội thất, người đăng, từ khoá không dấu). Nhờ vậy nếu API bỏ qua một tham số thì danh sách vẫn đúng bộ lọc, chỉ ít tin hơn.

## Lưu ý

- API của Chợ Tốt là API nội bộ, không có tài liệu chính thức và có thể đổi bất cứ lúc nào. Mã giá trị một vài bộ lọc (`furnishing_rent`, `sp`) được lấy theo URL của nhatot.com và gom ở đầu `public/filters.js` / `public/index.html`. Nếu Nhà Tốt đổi mã, chỉ cần sửa ở đó.
- Công cụ dùng cho mục đích cá nhân (tìm phòng). Tôn trọng [điều khoản sử dụng của Chợ Tốt](https://trogiup.chotot.com/), không dùng để thu thập dữ liệu hàng loạt. Nút *Tải tất cả* có giới hạn và server có cache để tránh gọi API quá nhiều.
- Ảnh và nội dung tin thuộc về người đăng / Chợ Tốt. Bấm vào tin để xem đầy đủ và liên hệ trên nhatot.com.
