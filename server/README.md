# ANCHOR Tsunami conversion server

The app itself runs entirely in the browser. Turning Word, Excel and PowerPoint files into PDF needs an
office engine, so that one feature uses this small server, which runs LibreOffice. Your files go only to
the server you run.

## Run it

With Docker:

```sh
docker build -t anchor-convert server/
docker run -p 8787:8787 -e ALLOW_ORIGINS=https://thecrayonlord.github.io anchor-convert
```

Without Docker (Node 18+ and LibreOffice installed):

```sh
node server/convert-server.mjs
```

Then in ANCHOR Tsunami open **Convert → Office to PDF**, enter the server address (for example
`http://localhost:8787`), and pick a file.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8787 | Port to listen on |
| `ALLOW_ORIGINS` | the GitHub Pages site and localhost | Comma-separated web origins allowed to call the server (`*` for any) |
| `TOKEN` | none | Optional shared secret; the app sends it as a bearer token |
| `MAX_MB` | 50 | Largest accepted file |
| `TIMEOUT_S` | 120 | Longest a conversion may take |
| `SOFFICE` | `soffice` | Path to the LibreOffice binary |

If you host it somewhere public (Render, Fly.io, a VPS), put it behind HTTPS and set `TOKEN`.
Browsers block calls from the HTTPS app to a plain `http://` address other than `localhost`.
