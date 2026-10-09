'use strict';

// Dự phòng khi admin quên mật khẩu và mất hết mã khôi phục:
//   npm run reset-admin              (admin đầu tiên)
//   npm run reset-admin -- tenadmin  (admin có tên đăng nhập này)
// Docker: docker compose exec heatmap npm run reset-admin
// Đặt mật khẩu mới ngẫu nhiên, in ra màn hình, đăng xuất admin đó ở mọi nơi.
// Không đụng tới tài khoản người tham gia hay dữ liệu phiên. Chạy được cả khi server đang chạy.
const path = require('node:path');
const { createAuth } = require('./auth');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const auth = createAuth({ dataDir, log: () => {} });
const out = auth.resetAdmin(process.argv[2]);
if (!out) {
  console.error(process.argv[2] ? `Không có admin tên "${process.argv[2]}".` : `Chưa có admin nào trong ${dataDir}.`);
  process.exit(1);
}
console.log(`Đã đặt lại mật khẩu admin.\n  Tên đăng nhập: ${out.username}\n  Mật khẩu mới:  ${out.password}\nĐăng nhập rồi đổi mật khẩu và tạo mã khôi phục mới.`);
