{{- define "kubeviz.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "kubeviz.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{ include "kubeviz.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "kubeviz.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kubeviz.serviceAccountName" -}}
{{- default (include "kubeviz.fullname" .) .Values.serviceAccount.name -}}
{{- end -}}

{{- define "kubeviz.tlsSecretName" -}}
{{- default (printf "%s-tls" (include "kubeviz.fullname" .)) .Values.tls.secretName -}}
{{- end -}}

{{- define "kubeviz.servicePort" -}}
{{- if .Values.service.port -}}{{ .Values.service.port }}{{- else if .Values.tls.enabled -}}443{{- else -}}80{{- end -}}
{{- end -}}

{{/* Endereço de retorno do login OIDC. */}}
{{- define "kubeviz.oidcRedirectURL" -}}
{{- if .Values.oidc.redirectURL -}}
{{- .Values.oidc.redirectURL -}}
{{- else if .Values.ingress.enabled -}}
{{- printf "https://%s/auth/oidc/callback" .Values.ingress.host -}}
{{- else -}}
{{- fail "defina oidc.redirectURL (endereço público de /auth/oidc/callback) ou habilite o ingress" -}}
{{- end -}}
{{- end }}
