# Heatmap online (Eye tracking - test)

Bản online của **Heatmap 4.1.0**: chạy trên một máy chủ có HTTPS, người tham gia ở bất kỳ đâu mở link, đăng nhập bằng tài khoản được cấp và làm kịch bản ngay trên trình duyệt của họ. Toàn bộ dữ liệu (heatmap, eye tracking, ghi màn hình, ghi âm, transcript) về máy chủ của bạn.

Thư mục này độc lập với app desktop ở thư mục gốc: có `package.json`, server và giao diện riêng.

## Ba loại tài khoản

| | Admin | Mod | Guest (người tham gia) |
|---|---|---|---|
| Tạo bởi | Lần chạy đầu (`ADMIN_USERNAME` / `ADMIN_PASSWORD`) | Admin, trang **Nhóm quản lý** | Admin hoặc Mod, trang **Người tham gia** của kịch bản |
| Xem báo cáo, transcript, tóm tắt AI, tải JSON/CSV | ✓ | ✓ | – |
| Tạo, đổi tên, cấu hình kịch bản | ✓ | ✓ | – |
| Chuyển phiên giữa kịch bản (kéo-thả) | ✓ | ✓ | – |
| Quản lý tài khoản guest | ✓ | ✓ | – |
| Xoá phiên, video / ghi âm, kịch bản | ✓ | – | – |
| Sửa cài đặt chung (nơi lưu, API key, eye tracking) | ✓ | – | – |
| Quản lý tài khoản Mod | ✓ | – | – |
| Làm kịch bản được giao | – | – | ✓ |
| Website được mở qua proxy | Mọi website | Mọi website | Chỉ domain của link trong kịch bản |

Các trang quản lý:
- **Kịch bản** (`/__et/scenarios.html`): danh sách mọi kịch bản với số phiên, tiến độ người tham gia (bao nhiêu người đã xong, ai đang ghi), tìm kiếm, tạo mới, đổi tên ngay trên dòng, đi tới cấu hình & người tham gia, danh sách phiên hoặc báo cáo tổng hợp. Admin có thêm nút xoá.
- **Nhóm quản lý** (`/__et/team.html`, chỉ admin): tạo tài khoản Mod (tên đăng nhập tự chọn hoặc tự tạo), cấp mật khẩu mới, khoá / mở khoá, xoá.

Guest không xem được báo cáo, phiên của người khác, danh sách kịch bản hay cài đặt. Với phiên của chính mình, guest chỉ gửi được dữ liệu ghi (sự kiện, video, ghi âm) và kết thúc phiên; không xoá, không đổi kịch bản, không tải dữ liệu về.

## Quy trình

1. **Admin / Mod** đăng nhập → **Kịch bản** → tạo kịch bản (ví dụ "Droppii Mall"):
   - **Link cần test**: website (`https://…`) hoặc prototype Figma.
   - **Nhiệm vụ** cho người tham gia.
   - Bật / tắt eye tracking bằng webcam, ghi âm micro.
2. Nhập tên người tham gia (mỗi dòng một người) → **Tạo tài khoản**. Mỗi người có tên đăng nhập (ví dụ `user12995`) và mật khẩu ngẫu nhiên. Mật khẩu **chỉ hiện một lần**: bấm **Sao chép thư mời** (có sẵn link, tên đăng nhập, mật khẩu) hoặc **Tải CSV**. Quên thì bấm **Cấp mật khẩu mới**.
3. **Người tham gia** mở link mời → đăng nhập → đọc nhiệm vụ → **Bắt đầu** → đồng ý ghi (màn hình đồng ý liệt kê rõ dữ liệu nào được ghi) → hiệu chỉnh webcam (nếu bật) → làm nhiệm vụ → **Hoàn thành**.
4. **Admin** xem kết quả. Thanh dưới header có breadcrumb (`Trang chủ › Droppii Mall › User 1 › Báo cáo`) và nút **‹ Trước / Sau ›** (hoặc phím Alt+← / Alt+→) để chuyển giữa các phiên cùng kịch bản trên trang Báo cáo và Transcript.
5. **Admin** thấy trạng thái tự cập nhật (Đã mời → Đã đăng nhập → Đang ghi → Đã xong), mở **Báo cáo** của từng người hoặc **Báo cáo tất cả phiên** của kịch bản.

Dữ liệu lưu giống app desktop: `Droppii Mall/User 1/` chứa `session.json`, `events.csv`, video ghi màn hình, ghi âm, transcript. Mỗi phiên còn ghi lại `guestId` và thời điểm đồng ý (`consentAt`).

## Quên mật khẩu

- **Mod:** nhờ admin bấm **Cấp mật khẩu mới** ở trang **Nhóm quản lý**, hoặc dùng mã khôi phục của mình.
- **Người tham gia (guest):** liên hệ người tổ chức. Admin / Mod bấm **Cấp mật khẩu mới** ở trang **Người tham gia** rồi gửi lại cho họ.
- **Admin / Mod: mã khôi phục.** Bấm vào tên mình ở góc phải trên → **Mã khôi phục** → nhập mật khẩu hiện tại → **Tạo mã khôi phục**.
  - App tạo 10 mã dạng `ABCD-EFGH`, chỉ hiện một lần. Mã được che (`••••-••••`) cho tới khi bấm **Hiện mã**. Bấm **Sao chép mã** hoặc **Tải file .txt** (luôn lấy mã thật) rồi cất ở nơi an toàn.
  - Khi quên mật khẩu: trang đăng nhập → **Quên mật khẩu?** → nhập tên đăng nhập, một mã và mật khẩu mới.
  - Mỗi mã dùng được một lần. Khi còn từ 2 mã trở xuống, header hiện cảnh báo để tạo bộ mới; tạo bộ mới thì bộ cũ hết hiệu lực.
  - Mã được lưu dạng băm. Nhập sai nhiều lần thì bị chặn tạm như khi đăng nhập sai.
- **Admin: dự phòng cuối** khi mất hết mã. Người có quyền vào máy chủ chạy lệnh dưới đây; lệnh in ra mật khẩu mới ngẫu nhiên, không đụng tới tài khoản guest hay dữ liệu, và chạy được cả khi server đang chạy:
  ```bash
  npm run reset-admin                          # chạy trên máy
  docker compose exec heatmap npm run reset-admin   # chạy bằng Docker
  ```

## Chạy thử trên máy

```bash
cd "Eye tracking - test"
npm install
ADMIN_PASSWORD=mat-khau-admin npm start
# mở http://localhost:3000/__et/  →  đăng nhập admin / mat-khau-admin
```

Nếu không đặt `ADMIN_PASSWORD`, lần chạy đầu tạo mật khẩu ngẫu nhiên và in ra log. Test website chạy trên máy (`http://localhost:…`) thì thêm `ALLOW_PRIVATE=1`.

Kiểm thử: `npm test`.

## Đưa lên Internet (VPS + tên miền)

Cần một máy chủ Linux có Docker (VPS khoảng 5–10 USD/tháng) và một tên miền trỏ về IP của máy chủ. Webcam chỉ hoạt động trên **HTTPS**; Caddy trong `docker-compose.yml` tự lấy chứng chỉ Let's Encrypt.

```bash
git clone <repo> && cd "<repo>/Eye tracking - test"
cp .env.example .env      # sửa DOMAIN, ADMIN_PASSWORD (và ANTHROPIC_API_KEY nếu dùng tóm tắt AI)
docker compose up -d --build
# mở https://<DOMAIN>/  →  đăng nhập admin
```

- Dữ liệu nằm trong volume `heatmap-data` (`/data` trong container). Sao lưu ra máy chủ: `docker compose cp heatmap:/data ./backup-$(date +%F)`.
- Cập nhật phiên bản: `git pull && docker compose up -d --build`.
- Nền tảng khác (Render, Fly.io, Railway…): dùng `Dockerfile`, gắn ổ lưu trữ bền vào `/data`, đặt các biến môi trường bên dưới.

### Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Tài khoản admin tạo ở lần chạy đầu (khi chưa có admin nào) |
| `PORT`, `HOST` | Cổng / địa chỉ lắng nghe (Docker: `3000`, `0.0.0.0`) |
| `DATA_DIR` | Thư mục dữ liệu (Docker: `/data`) |
| `TRUST_PROXY=1` | Đứng sau reverse proxy: lấy IP thật từ `X-Forwarded-For` để giới hạn đăng nhập sai |
| `COOKIE_SECURE=1` | Cookie đăng nhập chỉ gửi qua HTTPS (mặc định tự nhận theo `X-Forwarded-Proto`) |
| `ANTHROPIC_API_KEY` | Tuỳ chọn, cho tóm tắt AI |
| `ALLOW_PRIVATE=1` | Chỉ dùng khi thử trên máy: cho phép mở website trong mạng nội bộ |

## Bảo mật

- Mật khẩu băm bằng scrypt; phiên đăng nhập là token ngẫu nhiên trong cookie `HttpOnly`, `SameSite=Lax` (và `Secure` khi chạy HTTPS). Server chỉ lưu bản băm của token.
- Đăng nhập sai 8 lần trong 15 phút (theo IP + tên đăng nhập) thì bị chặn tạm thời.
- Khoá tài khoản, cấp mật khẩu mới hay xoá tài khoản đều đăng xuất người đó ngay.
- Proxy chỉ phục vụ người đã đăng nhập. Guest chỉ mở được domain của kịch bản, nên link không bị dùng làm proxy mở cho người lạ.
- Cookie đăng nhập không bao giờ được chuyển tiếp sang website đang test, và website đó không ghi đè được cookie của công cụ.
- **Lưu ý quan trọng:** để ghi được tương tác, website được test chạy **cùng origin** với công cụ (qua proxy). Vì vậy chỉ nên test website bạn tin cậy (ví dụ website của chính công ty). Một website độc hại có thể gọi API của công cụ bằng phiên đăng nhập của người đang xem nó, kể cả admin khi mở báo cáo. Bước tiếp theo nên làm là tách proxy sang một tên miền phụ riêng (ví dụ `test.<domain>`).

## Giới hạn

- Eye tracking bằng webcam cần máy tính, Chrome hoặc Edge. Trên điện thoại chỉ nên ghi chạm và cuộn.
- Người tham gia ở xa tự hiệu chỉnh không có người hướng dẫn: nên dặn ngồi nơi đủ sáng, mặt nhìn thẳng camera. Admin xem độ chính xác hiệu chỉnh trong báo cáo.
- Figma: dùng Figma Embed, ghi được ánh nhìn và việc chuyển màn hình, không ghi được click bên trong prototype.
- Website có chống bot (Cloudflare challenge), đăng nhập bằng bên thứ ba, hoặc gọi API tuyệt đối sang domain khác có thể không chạy đúng qua proxy.
- File `file://` trên máy không dùng được trong bản online.
