# Conversion server for ANCHOR Tsunami: Office files to PDF with LibreOffice.
#   docker build -t anchor-convert server/
#   docker run -p 8787:8787 -e ALLOW_ORIGINS=https://thecrayonlord.github.io anchor-convert
FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw fonts-dejavu fonts-liberation fonts-noto-core fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY convert-server.mjs .
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "convert-server.mjs"]
