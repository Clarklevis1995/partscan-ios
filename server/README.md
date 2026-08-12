# PartScan API

这是 PartScan iOS App 配套的 NestJS + TypeScript 服务端。服务负责安全保存阿里云百炼与 OpenAI API Key、接收说明书图片、异步调用可选择的视觉模型生成取件表，并提供手动删除说明书图片的接口。

## 本地运行

```bash
cp .env.example .env
npm install
npm run start:dev
```

本地开发默认使用 `QWEN_MOCK=true`，因此不配置外部 API Key 也能跑通创建产品、上传说明书、异步分析和查询取件表的完整流程。

需要调用阿里云百炼时，请修改 `.env`：

```env
QWEN_MOCK=false
DASHSCOPE_API_KEY=你的百炼API密钥
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_FLASH_MODEL=qwen3.7-flash
QWEN_PLUS_MODEL=qwen3.7-plus
QWEN_MAX_MODEL=qwen3.7-max-2026-06-08
QWEN_38_MAX_MODEL=qwen3.8-max-preview
QWEN_38_REASONING_EFFORT=medium
QWEN_OCR_MODEL=qwen3.5-ocr

OPENAI_API_KEY=你的OpenAI API密钥
OPENAI_BASE_URL=https://api.openai.com/v1
```

请先在百炼控制台确认当前账户和地域实际支持的模型 ID。API Key 只能保存在服务端，不能写入 iOS App。

客户端仍使用稳定的业务标识 `qwen3.7-max`，服务端通过 `QWEN_MAX_MODEL` 将其映射到支持图片输入的 `qwen3.7-max-2026-06-08`。不要将该环境变量改成 `qwen3.7-max`：这个别名当前对应仅支持文本的 2026-05-20 快照，发送 `image_url` 会返回 `Unexpected item type in content`。

`qwen3.8-max` 是客户端使用的业务标识，服务端默认映射到官方 `qwen3.8-max-preview`。该模型目前仅限 Token Plan，支持视觉理解但必须开启思考模式；服务端仅对该模型设置 `enable_thinking=true`、`temperature=0.6` 和 `QWEN_38_REASONING_EFFORT`，其他模型仍关闭思考。`QWEN_38_REASONING_EFFORT` 可设为 `low`、`medium` 或 `xhigh`。

OpenAI 模型使用 Responses API，客户端可选择 `gpt-5.6-sol`、`gpt-5.6-terra` 或 `gpt-5.6-luna`。推理强度、VLM 每批页数和多尺度切片开关由客户端在每次创建分析任务时提交；OpenAI API Key 只保存在服务端。

## API 接口

所有接口默认使用 `/v1` 前缀。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/v1/health` | 服务健康检查 |
| `POST` | `/v1/products` | 创建产品；使用 multipart 字段 `name` 和可选的 `cover` |
| `GET` | `/v1/products` | 获取产品列表 |
| `GET` | `/v1/products/:id` | 获取产品状态、说明书页数和取件表状态 |
| `GET` | `/v1/products/:id/cover` | 获取产品封面 |
| `POST` | `/v1/products/:id/manual-pages` | 上传说明书图片，multipart 字段名为 `pages` |
| `DELETE` | `/v1/products/:id/manual-cache` | 主动清除指定产品的说明书图片缓存 |
| `GET` | `/v1/analysis/models` | 获取 App 可选择的云端模型 |
| `POST` | `/v1/products/:id/analysis` | 创建异步说明书分析任务 |
| `GET` | `/v1/analysis/:id` | 查询分析状态、进度和错误信息 |
| `GET` | `/v1/products/:id/parts-list` | 获取最终的结构化取件表 |
| `POST` | `/v1/testing/ocr?provider=qwen\|tencent` | 开发环境上传单张图片并选择 OCR Provider |

### 使用 Postman 测试 OCR

创建 `POST http://127.0.0.1:3000/v1/testing/ocr` 请求，在 Postman 的 **Body → form-data** 中添加以下字段：

| Key | 类型 | Value |
| --- | --- | --- |
| `image` | File | 选择 JPG、PNG、WebP 或 HEIC 图片 |

不要手动填写 `Content-Type`，Postman 会自动生成包含 boundary 的 `multipart/form-data` 请求头。等价的 curl 命令：

```bash
curl --fail --show-error \
  -F 'image=@manual-test/manual-page.jpg' \
  http://127.0.0.1:3000/v1/testing/ocr
```

通过查询参数选择 Provider：

- Qwen：`POST http://127.0.0.1:3000/v1/testing/ocr?provider=qwen`
- 腾讯云：`POST http://127.0.0.1:3000/v1/testing/ocr?provider=tencent`
- 不传 `provider` 时默认使用 `qwen`

两种请求的 Body 都选择 `form-data`，文件字段名为 `image`、字段类型为 `File`。成功响应包含实际使用的 `provider`、`model`、原始 `text`、`plateDictionary`、规范化 `labels`、文字坐标 `boxes`、`durationMs`、文件名、MIME 类型和字节数。服务端会利用文字坐标将相邻的板件编号和圆圈数字合并，例如把 `A1` 与 `7` 规范化为 `A1(7)`。该测试接口在 `NODE_ENV=production` 时自动返回 404。

### 配置腾讯云 OCR

先在 `.env` 配置腾讯云凭证（不要提交该文件）：

```env
TENCENTCLOUD_SECRET_ID=你的SecretId
TENCENTCLOUD_SECRET_KEY=你的SecretKey
TENCENTCLOUD_REGION=ap-guangzhou
```

接口使用腾讯云 `GeneralAccurateOCR`，返回原始文本行 `detections`、图片角度 `angle`、腾讯云 `requestId`，以及与现有流水线一致的 `plateDictionary`、`labels` 和 `boxes`。

若希望正式分析任务使用腾讯云 OCR 辅助，将 `.env` 设置为 `OCR_PROVIDER=tencent`；设置为 `qwen` 时继续使用 Qwen 3.5 OCR。iOS 端仍只需要控制“是否开启 OCR 辅助识别”。

## 调用示例

### 1. 创建产品

```bash
curl \
  -F 'name=RG Hi-ν 高达' \
  -F 'cover=@cover.jpg' \
  http://localhost:3000/v1/products
```

响应中会返回产品 ID，后续上传和分析接口需要使用该 ID。

### 2. 上传说明书分页

```bash
curl \
  -F 'pages=@page-1.jpg' \
  -F 'pages=@page-2.jpg' \
  http://localhost:3000/v1/products/PRODUCT_ID/manual-pages
```

### 3. 启动分析

```bash
curl \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.7-flash","useOcr":true,"reasoningEffort":"medium","vlmBatchSize":3,"multiScaleEnabled":true}' \
  http://localhost:3000/v1/products/PRODUCT_ID/analysis
```

### 4. 查询任务状态

```bash
curl http://localhost:3000/v1/analysis/ANALYSIS_ID
```

任务状态可能为：

- `queued`：等待执行
- `analyzing`：说明书分析中
- `generating`：取件表生成中
- `completed`：取件表已生成
- `failed`：分析失败

### 5. 获取取件表

```bash
curl http://localhost:3000/v1/products/PRODUCT_ID/parts-list
```

## 图片保存与删除策略

- 上传的说明书图片在分析成功或失败后都会继续保留。
- 服务端不会定时或自动删除说明书图片。
- 只有调用 `DELETE /v1/products/:id/manual-cache` 时，才会删除指定产品的说明书图片。
- 产品封面不会随说明书图片一起删除。

## 模型处理逻辑

- 支持在 Qwen 与 OpenAI 多模态模型之间切换；OpenAI 提供 GPT-5.6 Sol、Terra、Luna 三档。
- 客户端通过 `multiScaleEnabled` 决定是否为每个新页面生成“完整页 + 三个带重叠的横向高清局部”。局部图经过轻度锐化，用于改善 `A1(1)` 等小标签识别；相同页面的多尺度结果不得重复计件。
- 客户端通过 `vlmBatchSize` 控制 Qwen 与 OpenAI 每批的新页面数量，允许 1–8，省略时默认 3。所有批次都使用全书页码作为 `sourcePages`。
- 客户端通过 `reasoningEffort` 控制 OpenAI 推理强度，可选 `none`、`low`、`medium`、`high`、`xhigh`、`max`，省略时默认 `medium`；该参数不影响 Qwen。
- 除第一批外，每批额外携带上一批最后一页作为只读上下文，用于跨批继承拼装单元和板件字典；提示词要求不重复计件，确定性合并层也会消除重复标签。
- 每批由 VLM 独立提取取件表。存在多个批次时，再调用一次同型号 LLM；汇总 LLM 只能返回“哪些 section 属于同一部位”的 ID 分组，不能生成或改写零件编号。
- 服务端根据该分组确定性合并板件和零件：相同“板件编号 + 零件编号”去重、来源页合并、重复引用的数量取各批最大值。汇总 LLM 遗漏的 section 会自动补回，避免丢件。
- 如果汇总 LLM 请求失败，则自动按完全相同的部位名称合并，并保留其余所有 section，整个分析不会因为汇总失败而丢失批次结果。
- 客户端通过 `useOcr` 动态控制是否启用 OCR 辅助识别，省略时默认为 `true`；任务创建后该设置不会随客户端开关变化。
- VLM 只接收说明书完整页及其高清局部，不接收 OCR 文本或标签，避免错误 OCR 对视觉判断形成锚定。
- 开启后，由 `OCR_PROVIDER` 选择 Qwen 3.5 OCR 或腾讯云 `GeneralAccurateOCR`，并与 VLM 独立并行运行。OCR 最多同时处理 3 页，单页失败不会导致 VLM 任务失败。
- 两条流水线完成后仅进行确定性比对：一致项不处理，OCR 独有标签进入 `uncertainItems` 提醒人工核对；OCR 不会新增、删除或改写取件表零件。
- 服务按“部位 → 板件 → 零件”输出结构化 JSON。
- 零件输出说明书中的数字编号、数量和 AI 推测的简短名称；数字编号是事实依据，名称仅作为辅助描述。
- 取件表不返回或展示模型置信度，保留来源页码用于追溯。
- 对跨页重复出现的相同板件和零件进行去重。
- 无法确认的内容放入 `uncertainItems`，避免模型强行猜测。

## 测试与构建

```bash
npm run build
npm run test:e2e
npm audit --omit=dev
```

### 使用真实说明书图片测试

`manual-test` 目录中包含测试脚本和同级测试图片。请先启动服务，再在另一个终端运行：

```bash
npm run test:real-image
```

脚本会自动创建产品、上传 `manual-test/manual-page.jpg`、发起分析、轮询任务状态、打印取件表，并确认说明书图片仍保留。默认使用 `qwen3.7-flash`；也支持 `qwen3.7-plus`、`qwen3.7-max`、`qwen3.8-max`、`gpt-5.6-sol`、`gpt-5.6-terra` 和 `gpt-5.6-luna`。例如：

```bash
MODEL=gpt-5.6-sol ./manual-test/test-real-image.sh
```

也可切换服务地址：

```bash
API_BASE_URL=http://127.0.0.1:3000/v1 npm run test:real-image
```

当 `.env` 中 `QWEN_MOCK=false` 时，该脚本会产生真实的云端模型调用费用。

端到端测试覆盖：创建产品、上传图片、启动异步分析、查询任务状态、获取取件表、确认图片保留，以及手动清空图片。

## Docker 运行

```bash
docker build -t partscan-api .
docker run --env-file .env -p 3000:3000 partscan-api
```

## 正式部署前注意事项

- 当前产品和任务元数据保存在进程内存中，服务重启后会丢失。正式上线前应替换为 PostgreSQL。
- 对外开放前必须加入用户登录和 JWT 鉴权，并通过 HTTPS 提供服务。
- 不要在 iOS App 中内置共享服务端密钥或百炼 API Key。
- 多实例部署时，应将说明书临时文件迁移到私有对象存储，并配置生命周期自动删除。
- 后台分析任务建议迁移到 BullMQ、Redis 或云端消息队列，避免服务重启导致任务中断。
- 应使用真实说明书测试板件和零件的跨页去重策略，并为低置信度结果提供人工确认界面。
# 万代说明书采集 API

服务端可从万代官方 WEB 说明书站拉取产品名称、封面和 PDF，并在 Node.js 进程内将 PDF 印刷面切割为独立逻辑页 JPG。归档写入 `STORAGE_DIR/bandai-manuals/`。

```bash
curl -X POST http://127.0.0.1:3000/v1/bandai-manuals/import \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "ガンダムレオパルド",
    "startPage": 1,
    "endPage": 1,
    "limit": 1,
    "delayMs": 1500,
    "jpgDpi": 200,
    "splitColumns": 0,
    "overwrite": false
  }'
```

`splitColumns: 0` 根据 PDF 印刷面的长宽比自动识别横向拼版列数；传入 `5` 可强制每个印刷面切成 5 页，传入 `1` 只转换格式、不横向切割。接口当前为同步测试接口，批量较大时请求会持续较长时间，建议先用 `limit: 1` 验证。

`query` 同时支持日文名、英文名、品番和 JAN 编码。例如下面两个搜索词都可以找到 Gundam Leopard：

```json
{ "query": "ガンダムレオパルド", "limit": 1 }
```

```json
{ "query": "GUNDAM LEOPARD", "limit": 1 }
```

旧字段 `freeword` 仍然可用；如果两个字段同时传入，优先使用 `query`。

PDF 解析、渲染和裁切由随服务安装的 `pdfjs-dist`、`@napi-rs/canvas` 和 `sharp` 完成，不依赖宿主机的 Poppler、ImageMagick 或 Homebrew。服务要求 Node.js `>=22.13`；执行 `npm ci` 或构建仓库中的 Dockerfile 即会安装所需运行时和当前平台的原生二进制包。

归档结构：

```text
storage/bandai-manuals/<说明书ID_品番_产品名称>/
├── cover.jpg
├── manual.pdf
├── product-name.txt
├── product.json
├── sheets/sheet-1.jpg
└── pages/page-001.jpg
```
