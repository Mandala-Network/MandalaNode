#!/bin/sh

set -e

host1="$1"
port1="$2"
host2="$3"
port2="$4"
shift 4

echo "Waiting for $host1:$port1..."
while ! nc -z $host1 $port1; do
  sleep 1
done
echo "$host1:$port1 is up"

echo "Waiting for $host2:$port2..."
while ! nc -z $host2 $port2; do
  sleep 1
done
echo "$host2:$port2 is up"

echo "Waiting for /kubeconfig/kubeconfig.yaml to be created..."
while [ ! -f /kubeconfig/kubeconfig.yaml ]; do
  sleep 1
done
echo "kubeconfig.yaml found"

# Wait until the file has content (k3s may create it empty first)
while [ ! -s /kubeconfig/kubeconfig.yaml ]; do
  sleep 1
done
echo "kubeconfig.yaml has content"

sleep 1
sed -i 's/https:\/\/127.0.0.1:6443/https:\/\/mandala-k3s:6443/g' /kubeconfig/kubeconfig.yaml

exec "$@"