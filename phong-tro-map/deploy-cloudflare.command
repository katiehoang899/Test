#!/bin/bash
# Bấm đúp file này (macOS) để đưa RentMAPs lên Cloudflare Pages: https://timtro.pages.dev
# Lần đầu: đăng nhập Cloudflare (mở trình duyệt), tạo cơ sở dữ liệu D1, đặt mật khẩu cho trang,
# (tuỳ chọn) chép dữ liệu trong máy lên. Các lần sau: chỉ cập nhật code mới.
# Đổi tên dự án: PROJECT=ten-khac ./deploy-cloudflare.command · Đổi mật khẩu: CHANGE_PASSWORD=1 ./deploy-cloudflare.command
cd "$(dirname "$0")" || exit 1
PROJECT="${PROJECT:-timtro}"
DB_NAME="timtro-db"
W="npx --yes wrangler@4"
export WRANGLER_SEND_METRICS=false

pause_exit() {
  echo
  read -n 1 -s -r -p "Bấm phím bất kỳ để đóng cửa sổ…"
  echo
  exit "$1"
}
step() { echo; echo "▶ $1"; }

if ! command -v node >/dev/null 2>&1; then
  echo "Máy chưa cài Node.js. Tải bản LTS tại https://nodejs.org, cài xong rồi bấm đúp lại file này."
  open "https://nodejs.org/" 2>/dev/null
  pause_exit 1
fi

step "1/6 Đăng nhập Cloudflare"
if $W whoami 2>&1 | grep -qi "not authenticated"; then
  echo "Trình duyệt sẽ mở trang Cloudflare: đăng nhập (hoặc tạo tài khoản miễn phí) rồi bấm Allow."
  $W login || pause_exit 1
else
  $W whoami 2>&1 | grep -i "email\|account" | head -3
fi

step "2/6 Cơ sở dữ liệu D1 ($DB_NAME): tin đã lưu, điểm ngập, đỗ xe"
d1_id() { $W d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=JSON.parse(s);const d=l.find(x=>x.name===process.argv[1]);if(d)console.log(d.uuid)}catch{}})' "$DB_NAME"; }
ID="$(d1_id)"
if [ -z "$ID" ]; then
  $W d1 create "$DB_NAME" || pause_exit 1
  ID="$(d1_id)"
fi
if [ -z "$ID" ]; then echo "Không lấy được id của cơ sở dữ liệu $DB_NAME."; pause_exit 1; fi
sed -i '' "s/^database_id = \"[^\"]*\"/database_id = \"$ID\"/" wrangler.toml
echo "D1: $ID"
$W d1 execute "$DB_NAME" --remote --command "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)" >/dev/null || pause_exit 1

step "3/6 Dự án Cloudflare Pages ($PROJECT)"
if ! $W pages project list 2>/dev/null | grep -qw "$PROJECT"; then
  $W pages project create "$PROJECT" --production-branch main || pause_exit 1
fi

step "4/6 Mật khẩu của trang"
if [ -n "$CHANGE_PASSWORD" ] || ! $W pages secret list --project-name "$PROJECT" 2>/dev/null | grep -q APP_PASSWORD; then
  echo "Trang trên mạng ai có link cũng mở được, nên cần mật khẩu (nhập một lần trên mỗi máy, trình duyệt nhớ 1 năm)."
  while true; do
    read -s -r -p "Đặt mật khẩu: " PW; echo
    read -s -r -p "Nhập lại: " PW2; echo
    if [ -z "$PW" ]; then echo "Mật khẩu không được để trống."; continue; fi
    if [ "$PW" != "$PW2" ]; then echo "Hai lần nhập không khớp, nhập lại."; continue; fi
    break
  done
  printf '%s' "$PW" | $W pages secret put APP_PASSWORD --project-name "$PROJECT" || pause_exit 1
else
  echo "Đã có mật khẩu (muốn đổi: chạy lại với CHANGE_PASSWORD=1)."
fi

step "5/6 Chép dữ liệu trong máy lên (tin đã lưu, điểm ngập, đỗ xe)"
HAS_DATA=""
for f in saved floods parking; do [ -f "data/$f.json" ] && HAS_DATA="1"; done
if [ -n "$HAS_DATA" ]; then
  read -r -p "Chép dữ liệu trong thư mục data/ lên Cloudflare (thay dữ liệu trên mạng nếu đã có)? [c/K] " ANS
  if [ "$ANS" = "c" ] || [ "$ANS" = "C" ]; then
    SQL="$(mktemp -t rentmaps-sql)"
    # Mỗi câu lệnh D1 tối đa 100 KB: chia nội dung dài thành nhiều đoạn, nối dần bằng UPDATE … || ….
    node -e '
      const fs = require("fs");
      const out = [];
      const q = (s) => "'"'"'" + s.replace(/'"'"'/g, "'"'"''"'"'") + "'"'"'";
      for (const key of ["saved", "floods", "parking"]) {
        let text; try { text = JSON.stringify(JSON.parse(fs.readFileSync("data/" + key + ".json", "utf8"))); } catch { continue; }
        const parts = text.match(/[\s\S]{1,20000}/g) || ["null"];
        out.push(`INSERT INTO kv (key, value) VALUES (${q(key)}, ${q(parts[0])}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);
        for (const p of parts.slice(1)) out.push(`UPDATE kv SET value = value || ${q(p)} WHERE key = ${q(key)};`);
        console.error("  " + key + ".json");
      }
      fs.writeFileSync(process.argv[1], out.join("\n"));
    ' "$SQL" || pause_exit 1
    $W d1 execute "$DB_NAME" --remote --file "$SQL" --yes >/dev/null || pause_exit 1
    rm -f "$SQL"
    echo "Đã chép."
  fi
else
  echo "Không có dữ liệu trong data/, bỏ qua."
fi

step "6/6 Đưa code lên Cloudflare"
$W pages deploy --project-name "$PROJECT" --branch main --commit-dirty=true || pause_exit 1

echo
echo "✅ Xong. Mở RentMAPs tại: https://$PROJECT.pages.dev"
echo "   (nếu tên $PROJECT đã có người dùng, Cloudflare thêm vài ký tự: xem dòng 'Deployment complete' ở trên)"
open "https://$PROJECT.pages.dev" 2>/dev/null
pause_exit 0
