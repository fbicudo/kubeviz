#!/usr/bin/env bash
# Sobe um Keycloak local (http://127.0.0.1:8180, realm "kubeviz") para testar o
# login OIDC do KubeViz e aplica as permissões da usuária de teste no kind.
#
# A senha da usuária bia@kubeviz.test (grupo "dev") e o client secret são
# aleatórios e ficam em ~/.config/kubeviz/oidc-demo (fora do repositório). Os
# tokens duram 2 min, para exercitar a renovação do login.
#
# Uso: hack/oidc/keycloak.sh [up|down]     (DOCKER="sudo docker" se preciso)
set -euo pipefail

DOCKER="${DOCKER:-docker}"
IMAGE="quay.io/keycloak/keycloak:26.4.2"
here="$(cd "$(dirname "$0")" && pwd)"
dir="${KUBEVIZ_OIDC_DEMO_DIR:-$HOME/.config/kubeviz/oidc-demo}"

if [[ "${1:-up}" == down ]]; then
  $DOCKER rm -f kubeviz-keycloak > /dev/null
  echo "Keycloak removido."
  exit 0
fi

umask 077
mkdir -p "$dir/keycloak"
random() { head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24; }
[[ -s "$dir/keycloak-password" ]] || random > "$dir/keycloak-password"
[[ -s "$dir/keycloak-client-secret" ]] || random > "$dir/keycloak-client-secret"
sed -e "s|@PASSWORD@|$(cat "$dir/keycloak-password")|" -e "s|@SECRET@|$(cat "$dir/keycloak-client-secret")|" \
  "$here/keycloak-realm.json" > "$dir/keycloak/kubeviz-realm.json"
chmod 755 "$dir/keycloak" && chmod 644 "$dir/keycloak/kubeviz-realm.json" # lidos pelo container

$DOCKER rm -f kubeviz-keycloak > /dev/null 2>&1 || true
$DOCKER run -d --name kubeviz-keycloak --network host \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD="$(random)" \
  -v "$dir/keycloak:/opt/keycloak/data/import:ro" \
  "$IMAGE" start-dev --http-port 8180 --http-host 127.0.0.1 --import-realm > /dev/null
kubectl --context kind-kubeviz-dev apply -f "$here/rbac.yaml" > /dev/null

cat <<MSG
Keycloak subindo em http://127.0.0.1:8180/realms/kubeviz (leva ~30 s)
  usuária: bia (bia@kubeviz.test, grupo dev: leitura em demo)
  senha:   $dir/keycloak-password

Inicie o KubeViz com:
  ./bin/kubeviz --kubeconfig ~/.kube/kubeviz-demo.yaml \\
    --oidc-issuer-url http://127.0.0.1:8180/realms/kubeviz --oidc-client-id kubeviz \\
    --oidc-client-secret-file $dir/keycloak-client-secret \\
    --oidc-redirect-url http://127.0.0.1:4466/auth/oidc/callback --oidc-display-name Keycloak
MSG
