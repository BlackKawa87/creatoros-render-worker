# GrowCreator Render Worker (Railway)

Pipeline: yt-dlp → ffmpeg (1080x1920, 9:16) → Supabase Storage → callback.

## Arquivos
- `server.js` — Express + pipeline + callbacks progressivos
- `package.json` — Node 22, express, @supabase/supabase-js
- `Dockerfile` — Node 22 + ffmpeg + yt-dlp (binário estático mais recente)

## Variáveis de ambiente (Railway → Variables)

| Variável | Obrigatório | Descrição |
|---|---|---|
| `RENDER_WORKER_SECRET` | sim | Bearer secret compartilhado com o Lovable |
| `SUPABASE_URL` | sim | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | sim | Service role key (upload no Storage) |
| `STORAGE_BUCKET` | não | Default: `rendered-clips` |
| `YT_COOKIES_BASE64` | recomendado | Cookies do YouTube em base64 (ver abaixo) |
| `PORT` | não | Default: `8080` (Railway injeta) |

## Endpoints
- `GET /` → `{ "status": "ok" }`
- `GET /health` → `{ "status": "ok", "service": "growcreator-render-worker" }`
- `POST /render` (Bearer auth) → enfileira job, responde `202`, processa em background

## Como gerar `YT_COOKIES_BASE64`

O erro `Sign in to confirm you're not a bot` do yt-dlp no Railway é resolvido
fornecendo cookies de uma sessão real do YouTube.

### 1. Exportar cookies do navegador

Use uma destas extensões em uma aba já logada no YouTube
(de preferência uma **conta secundária**, não a principal):

- Chrome/Edge: **Get cookies.txt LOCALLY**
- Firefox: **cookies.txt**

Exporte como `cookies.txt` no formato **Netscape**.

> Dica: depois de exportar, abra `youtube.com` em uma janela anônima e
> faça logout — assim a sessão exportada não é invalidada por novo login.

### 2. Converter para base64 (uma linha)

**macOS / Linux:**
```bash
base64 -w 0 cookies.txt > cookies.b64
# ou (macOS sem -w):
base64 -i cookies.txt | tr -d '\n' > cookies.b64
```

**Windows PowerShell:**
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cookies.txt")) | Set-Content cookies.b64
```

### 3. Adicionar no Railway

1. Abra o serviço do worker no Railway.
2. **Variables → New Variable**.
3. Nome: `YT_COOKIES_BASE64`
4. Valor: cole o conteúdo de `cookies.b64` (string única, sem quebras de linha).
5. Salve. O Railway faz redeploy automaticamente.

Na inicialização o worker decodifica e escreve em
`/tmp/youtube_cookies.txt`, e o yt-dlp passa a usar
`--cookies /tmp/youtube_cookies.txt` em todos os downloads.

### 4. Verificar
```bash
curl https://accomplished-strength-production-422a.up.railway.app/health
# logs do Railway devem mostrar:
# [cookies] wrote N bytes to /tmp/youtube_cookies.txt
```

### Renovação
Os cookies do YouTube expiram. Se o erro de bot voltar:
1. Re-exporte `cookies.txt` da mesma conta.
2. Gere novo base64.
3. Atualize a variável no Railway.

## Flags do yt-dlp usadas
```
--no-playlist
--no-check-certificate
--force-ipv4
--retries 5
--fragment-retries 5
--extractor-args youtube:player_client=android,web
--cookies /tmp/youtube_cookies.txt   (se YT_COOKIES_BASE64 setado)
```

## Deploy no Railway

Suba os 3 arquivos na raiz do repositório do worker; o Railway detecta
o `Dockerfile` automaticamente. Não há nada extra a configurar além das
variáveis acima.
