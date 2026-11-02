package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"k8s.io/client-go/rest"

	"github.com/fbicudo/kubeviz/backend/internal/cluster"
)

// Cluster é o que o servidor precisa da conexão com o Kubernetes.
// Implementado por *cluster.Manager.
type Cluster interface {
	Mode() cluster.Mode
	Info(ctx context.Context) cluster.Info
	Contexts() []cluster.ContextInfo
	UseContext(name string) error
	RESTConfig() *rest.Config
	ConfigForToken(token string) *rest.Config
}

type contextsResponse struct {
	Mode     cluster.Mode          `json:"mode"`
	Contexts []cluster.ContextInfo `json:"contexts"`
}

func (s *Server) getCluster(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.cluster.Info(r.Context()))
}

func (s *Server) getContexts(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, contextsResponse{Mode: s.cluster.Mode(), Contexts: s.cluster.Contexts()})
}

func (s *Server) putCurrentContext(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		writeError(w, http.StatusBadRequest, `corpo inválido: esperado {"name": "<contexto>"}`)
		return
	}

	switch err := s.cluster.UseContext(body.Name); {
	case errors.Is(err, cluster.ErrUnknownContext):
		writeError(w, http.StatusNotFound, err.Error())
		return
	case errors.Is(err, cluster.ErrSwitchNotSupported):
		writeError(w, http.StatusConflict, err.Error())
		return
	case err != nil:
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	s.log.Info("contexto alterado", "contexto", body.Name)
	writeJSON(w, http.StatusOK, s.cluster.Info(r.Context()))
}
