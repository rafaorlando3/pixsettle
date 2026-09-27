# Demo pública do PixSettle: Pix simulado ou Asaas sandbox + Tempo testnet. Sem dinheiro real.
FROM node:22-slim
WORKDIR /app
# Dependências pelos lockfiles, sem scripts de instalação.
COPY settlement/package.json settlement/package-lock.json settlement/
COPY core/package.json core/package-lock.json core/
RUN cd settlement && npm ci --ignore-scripts --no-audit --no-fund \
 && cd ../core && npm ci --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force
# Código (o verificador do navegador, web/public/verify.js, já vem compilado no repositório).
COPY contract contract
COPY settlement settlement
COPY core core
COPY web/public web/public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000 TRUST_PROXY=1
EXPOSE 10000
USER node
WORKDIR /app/core
CMD ["node", "--import", "tsx", "scripts/start-all.ts"]
