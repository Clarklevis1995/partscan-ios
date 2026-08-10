#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:3000/v1}"
MODEL="${MODEL:-qwen3.7-flash}"
IMAGE_PATH="${IMAGE_PATH:-${SCRIPT_DIR}/manual-page.jpg}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"
MAX_POLLS="${MAX_POLLS:-90}"

if [[ ! -f "${IMAGE_PATH}" ]]; then
  echo "测试图片不存在：${IMAGE_PATH}" >&2
  exit 1
fi

case "${MODEL}" in
  qwen3.7-flash|qwen3.7-plus|qwen3.7-max|qwen3.8-max|gpt-5.6-sol|gpt-5.6-terra|gpt-5.6-luna) ;;
  *)
    echo "不支持的 MODEL：${MODEL}" >&2
    echo "可选：qwen3.7-flash、qwen3.7-plus、qwen3.7-max、qwen3.8-max、gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna" >&2
    exit 1
    ;;
esac

json_field() {
  local field="$1"
  node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      const result = process.argv[1].split(".").reduce((current, key) => current?.[key], value);
      if (result === undefined || result === null) process.exit(2);
      process.stdout.write(String(result));
    });
  ' "${field}"
}

pretty_json() {
  node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => console.log(JSON.stringify(JSON.parse(input), null, 2)));
  '
}

echo "1/5 检查服务：${API_BASE_URL}"
curl --fail --silent --show-error "${API_BASE_URL}/health" | pretty_json

echo "2/5 创建测试产品"
product_json="$(curl --fail --silent --show-error -F "name=实图接口测试 $(date '+%Y-%m-%d %H:%M:%S')" "${API_BASE_URL}/products")"
product_id="$(printf '%s' "${product_json}" | json_field id)"
echo "productId=${product_id}"

echo "3/5 上传测试图片：${IMAGE_PATH}"
curl --fail --silent --show-error \
  -F "pages=@${IMAGE_PATH}" \
  "${API_BASE_URL}/products/${product_id}/manual-pages" | pretty_json

echo "4/5 发起分析：${MODEL}"
analysis_json="$(curl --fail --silent --show-error \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL}\"}" \
  "${API_BASE_URL}/products/${product_id}/analysis")"
analysis_id="$(printf '%s' "${analysis_json}" | json_field id)"
echo "analysisId=${analysis_id}"

for ((poll=1; poll<=MAX_POLLS; poll++)); do
  status_json="$(curl --fail --silent --show-error "${API_BASE_URL}/analysis/${analysis_id}")"
  status="$(printf '%s' "${status_json}" | json_field status)"
  progress="$(printf '%s' "${status_json}" | json_field progress)"
  echo "轮询 ${poll}/${MAX_POLLS}：status=${status} progress=${progress}%"

  if [[ "${status}" == "completed" ]]; then
    echo "5/5 分析完成，取件表如下："
    curl --fail --silent --show-error "${API_BASE_URL}/products/${product_id}/parts-list" | pretty_json
    echo "确认说明书图片仍保留，需通过 DELETE /products/:id/manual-cache 手动删除："
    curl --fail --silent --show-error "${API_BASE_URL}/products/${product_id}" | pretty_json
    exit 0
  fi

  if [[ "${status}" == "failed" ]]; then
    echo "分析失败：" >&2
    printf '%s' "${status_json}" | pretty_json >&2
    exit 1
  fi

  sleep "${POLL_INTERVAL}"
done

echo "等待分析超时，可继续查询 analysisId=${analysis_id}" >&2
exit 1
