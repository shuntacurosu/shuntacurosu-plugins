# 検証用サーバ: 中継ハブ + Web コンソール。node-pty のビルドに python/make/g++ が要るのでフルイメージを使う。
FROM node:22-bookworm

# 各セッションコンテナの tmux に attach するための docker CLI (ソケットは compose でマウント)
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

# リポジトリと同じ並びにする: index.js が ../../server/hub.js を読む
WORKDIR /app/dev/console
COPY package.json ./
RUN npm install --omit=dev
COPY . .
COPY --from=hubsrc hub.js package.json /app/server/

ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
