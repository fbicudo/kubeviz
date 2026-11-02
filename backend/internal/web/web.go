// Package web embute a interface compilada (frontend/dist, copiada para
// ./dist pelo build) e a serve como SPA.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var embedded embed.FS

// Assets devolve o sistema de arquivos da UI embutida.
func Assets() fs.FS {
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		panic(err) // "dist" sempre existe por causa do .gitkeep
	}
	return sub
}

const notBuilt = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Kubora</title>
<body style="font-family:system-ui;background:#0b0e14;color:#c9d1d9;padding:2rem">
<h1>Kubora</h1><p>A interface não foi compilada neste binário. Rode <code>make build</code>
ou use <code>make dev-frontend</code> durante o desenvolvimento.</p></body></html>`

// Handler serve arquivos estáticos de assets. Rotas que não correspondem a um
// arquivo recebem index.html, para o roteamento no navegador funcionar.
func Handler(assets fs.FS) http.Handler {
	fileServer := http.FileServerFS(assets)
	_, err := fs.Stat(assets, "index.html")
	built := err == nil

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !built {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(notBuilt))
			return
		}

		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name != "" {
			if info, err := fs.Stat(assets, name); err == nil && !info.IsDir() {
				if strings.HasPrefix(name, "assets/") {
					// Arquivos gerados pelo Vite têm hash no nome.
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				fileServer.ServeHTTP(w, r)
				return
			}
		}

		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFileFS(w, r, assets, "index.html")
	})
}
