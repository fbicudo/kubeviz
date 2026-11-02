// Package version expõe informações de build injetadas via -ldflags.
package version

import "runtime"

// Preenchidas em tempo de build:
//
//	go build -ldflags "-X kubora.dev/kubora/internal/version.Version=v0.1.0 ..."
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

// Info é a representação JSON da versão.
type Info struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	Date      string `json:"date"`
	GoVersion string `json:"goVersion"`
}

// Get devolve a versão atual do binário.
func Get() Info {
	return Info{Version: Version, Commit: Commit, Date: Date, GoVersion: runtime.Version()}
}
