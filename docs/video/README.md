# Vídeo da demo

Gravado contra uma instância local ligada à Tempo testnet (liquidação real, Pix simulado), com legendas em inglês na tela.

```bash
PW=$(npm root -g)/playwright BASE=http://127.0.0.1:8080 node docs/video/record-demo.cjs /tmp/video
ffmpeg -f concat -safe 0 -i /tmp/video/concat.txt -vf "scale=1920:1080:flags=lanczos,fps=30,format=yuv420p" \
  -c:v libx264 -preset slow -crf 19 -movflags +faststart -an pixsettle-demo-video.mp4
```

A captura é por screenshots com o horário real (cerca de 10 por segundo), porque a gravação nativa perdia quadros em trechos parados.
Para mudar o texto, edite as chamadas `caption(...)` e `slide(...)` no script. Nada de travessão nos textos.
