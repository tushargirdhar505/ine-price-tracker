# Official Playwright image — Chromium + all system libraries already
# installed, so we skip the whole "npx playwright install --with-deps"
# step entirely (that's what was failing on Render's native Node build).
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
