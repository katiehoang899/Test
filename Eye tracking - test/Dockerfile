# Heatmap online — chạy sau một reverse proxy có HTTPS (xem docker-compose.yml + Caddyfile).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

COPY package.json package-lock.json ./
# --ignore-scripts: không tải bản native của onnxruntime/sharp (chỉ dùng file chạy trên trình duyệt).
# Xoá các gói chỉ cần khi build để ảnh nhẹ hơn (server chỉ phục vụ file dist của chúng).
RUN npm ci --omit=dev --ignore-scripts \
 && rm -rf node_modules/onnxruntime-node node_modules/@img node_modules/sharp node_modules/@tensorflow node_modules/@mediapipe \
 && npm cache clean --force

COPY server.js auth.js ./
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/__et/login.html').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.js"]
