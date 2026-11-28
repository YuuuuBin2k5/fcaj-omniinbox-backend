# Hướng dẫn Triển khai AWS, IAM Policies & Vận hành (`aws-deploy.md`)

Tài liệu tham chiếu thông số chuẩn khi tạo tài nguyên và gắn code backend lên AWS (`ap-southeast-1`).

---

## 1. Thông số 6 Hàm AWS Lambda

| Tên hàm | Runtime / Arch | Memory | Timeout | IAM Role | Người deploy |
| :--- | :--- | :---: | :---: | :--- | :--- |
| `omni-webhook-ingest` | `nodejs22.x` · `arm64` | `128 MB` | `5 s` | `omni-ingest-role` | Hoài Nam |
| `omni-message-normalizer` | `nodejs22.x` · `arm64` | `256 MB` | `10 s` *(hoặc `5 s`)* | `omni-normalizer-role` | Hoài Nam |
| `omni-api-handler` | `nodejs22.x` · `arm64` | `128 MB` | `10 s` | `omni-api-role` | Hoài Nam |
| `omni-ws-handler` | `nodejs22.x` · `arm64` | `128 MB` | `10 s` | `omni-ws-role` | Duy |
| `omni-outbound-sender` | `nodejs22.x` · `arm64` | `256 MB` | `15 s` | `omni-outbound-role` | Duy |
| `omni-ai-suggester` *(Pha 2)* | `nodejs22.x` · `arm64` | `256 MB` | `15 s` | `omni-ai-role` | Duy *(nếu Go Ngày 9)* |

> **Lưu ý đồng bộ `omni-message-normalizer` & SQS:** Code khóa chống trùng dùng `STALE_LOCK_MS = 20_000` (20 giây), bắt buộc giữ đúng thứ tự **`Timeout Lambda < 20s < SQS Visibility Timeout`**. Nhóm chọn thống nhất **1 trong 2 cặp**: `10s / 60s` (khuyến nghị ổn định khi cold start/batch 5 tin) hoặc `5s / 30s` (test DLQ nhanh ~2–3 phút). SQS đặt `Maximum receives = 5`.

---

## 2. Bảng Biến môi trường theo từng Lambda

Mẫu đầy đủ lưu tại [.env.example](../.env.example). **Lưu ý quan trọng:** `WS_ENDPOINT` dùng `https://` (API Management endpoint để Lambda đẩy tin xuống WebSocket), **không** nhập `wss://`.

| Biến môi trường | `ingest` | `normalizer` | `api` | `ws` | `outbound` | `ai` | Giá trị chuẩn |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `CONVERSATIONS_TABLE` | | ✓ | ✓ | | ✓ | | `OmniConversations` |
| `MESSAGES_TABLE` | | ✓ | ✓ | | ✓ | ✓ | `OmniMessages` |
| `IDEMPOTENCY_TABLE` | | ✓ | ✓ | ✓ | | | `OmniIdempotency` |
| `WS_CONNECTIONS_TABLE` | | ✓ | ✓ | ✓ | ✓ | | `OmniWSConnections` |
| `INBOUND_QUEUE_URL` | ✓ | | | | | | `https://sqs.ap-southeast-1.amazonaws.com/<ACCOUNT_ID>/omni-inbound-queue` |
| `WEBHOOK_SECRET_SSM_PATH` | ✓ | | | | | | `/omniinbox/prod/webhook_secret` |
| `TELEGRAM_TOKEN_SSM_PATH` | | | | | ✓ | | `/omniinbox/prod/telegram_bot_token` |
| `WS_ENDPOINT` | | ✓ | ✓ | | ✓ | | `https://<WS_API_ID>.execute-api.ap-southeast-1.amazonaws.com/prod` |
| `ALLOWED_ORIGIN` | ✓ | | ✓ | | ✓ | ✓ | `*` lúc dev; đổi thành `https://<CLOUDFRONT_DOMAIN>` khi lên S3/CloudFront |
| `ALLOW_SIMULATOR` | ✓ | | | | | | `"true"` khi demo Simulator; `"false"` khi tắt mô phỏng |
| `REQUIRE_SIMULATOR_AUTH` | ✓ | | | | | | `"false"` mặc định; đặt `"true"` nếu gắn Cognito cho `/simulator/webhook/{channel}` |
| `ENABLE_FAULT_INJECTION` | | ✓ | | | | | `"false"` mặc định; chỉ bật `"true"` lúc test DLQ rồi tắt lại ngay |
| `BEDROCK_MODEL_ID` | | | | | | ✓ | Model hoặc Inference Profile đang `ACTIVE` trên `ap-southeast-1` |
| `BEDROCK_REGION` | | | | | | ✓ | `ap-southeast-1` *(hoặc region của inference profile)* |

---

## 3. Thứ tự phối hợp triển khai trên AWS

1. **Vi (Member 2):** Tạo trước 2 tham số SSM (`Standard`, `SecureString`), Cognito User Pool `omniinbox-agent-pool` (tắt self-registration, tạo 2 tài khoản bằng CLI với `--permanent`), và bộ 6+1 IAM Role.
2. **Trung Nam (Member 5):** Tạo sẵn 6 CloudWatch Log Group `/aws/lambda/omni-*` với **retention `7 days` trước khi deploy Lambda** (nếu để Lambda tự tạo mặc định sẽ thành `Never expire`).
3. **Hoài Nam (Member 3):** Tạo 4 bảng DynamoDB (kèm GSI `gsi-all-by-time` và bật TTL thuộc tính `ttl`), SQS + DLQ, deploy 3 Lambda (`ingest`, `normalizer`, `api`), dựng `OmniInbox-REST-API` stage `prod`, gắn **Cognito Authorizer bắt buộc cho cả 6 route nhân viên** (chỉ để public `POST /webhook/{channel}`), bật Gateway Responses `Default 4XX / 5XX` kèm CORS headers và throttling `20 rps / burst 40`.
   - *Lưu ý rà soát:* Hiện `omni-api-handler` tin cậy hoàn toàn vào Cognito Authorizer của API Gateway (chưa tự chặn `401` nếu thiếu authorizer như `omni-outbound-sender`), nên Hoài Nam cần kiểm tra kỹ Authorizer trên đủ 4 route của `omni-api-handler`.
4. **Duy (Member 4):** Tạo Telegram Bot và tự nạp token vào SSM, deploy `omni-ws-handler` + `OmniInbox-WebSocket-API`, deploy `omni-outbound-sender`, chạy `setWebhook` kèm `secret_token`, dựng S3 Private + CloudFront OAC (custom error `403/404 -> /index.html`). Cập nhật `<WS_API_ID>` cho Vi sửa lại 3 IAM Role và cập nhật `ALLOWED_ORIGIN` sang domain CloudFront cho các HTTP Lambda.
5. **Trung Nam & Cả nhóm (Ngày 8–9):** Bật access/execution log API Gateway, tạo Metric Filter `"[NORMALIZER_FAILURE]"` trên `/aws/lambda/omni-message-normalizer`, tạo 2 CloudWatch Alarm (`OmniInbox-DLQ-Messages-Alarm` và `OmniInbox-Normalizer-Failures-Alarm`) trỏ về SNS `omni-alert-topic` (`Missing data = notBreaching`), rồi họp chốt **Go/No-Go** phần AI Pha 2.

---

## 4. Inline IAM Policies cho 6 Lambda

Cả 6 Role đều dùng Trusted Entity `Lambda` + managed policy `AWSLambdaBasicExecutionRole`, kèm Inline Policy riêng bên dưới *(thay `<ACCOUNT_ID>` và `<WS_API_ID>`; nếu dùng KMS mặc định `alias/aws/ssm` thường không cần thêm `kms:Decrypt`)*.

### `omni-ingest-role`
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendToInboundQueueOnly",
      "Effect": "Allow",
      "Action": ["sqs:SendMessage"],
      "Resource": "arn:aws:sqs:ap-southeast-1:<ACCOUNT_ID>:omni-inbound-queue"
    },
    {
      "Sid": "ReadWebhookSecret",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter"],
      "Resource": "arn:aws:ssm:ap-southeast-1:<ACCOUNT_ID>:parameter/omniinbox/prod/webhook_secret"
    }
  ]
}
```

### `omni-normalizer-role`
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ConsumeInboundQueue",
      "Effect": "Allow",
      "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      "Resource": "arn:aws:sqs:ap-southeast-1:<ACCOUNT_ID>:omni-inbound-queue"
    },
    {
      "Sid": "ReadWriteCoreTables",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
      "Resource": [
        "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniIdempotency",
        "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniMessages",
        "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniConversations"
      ]
    },
    {
      "Sid": "BroadcastConnectionsOnly",
      "Effect": "Allow",
      "Action": ["dynamodb:Scan", "dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniWSConnections"
    },
    {
      "Sid": "PushToWebSocketClients",
      "Effect": "Allow",
      "Action": ["execute-api:ManageConnections"],
      "Resource": "arn:aws:execute-api:ap-southeast-1:<ACCOUNT_ID>:<WS_API_ID>/prod/POST/@connections/*"
    }
  ]
}
```

### `omni-api-role`
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ConversationsAndIndex",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"],
      "Resource": [
        "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniConversations",
        "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniConversations/index/*"
      ]
    },
    {
      "Sid": "ReadMessageHistory",
      "Effect": "Allow",
      "Action": ["dynamodb:Query"],
      "Resource": "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniMessages"
    },
    {
      "Sid": "IssueWebSocketTicket",
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem"],
      "Resource": "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniIdempotency"
    },
    {
      "Sid": "BroadcastConnectionsOnly",
      "Effect": "Allow",
      "Action": ["dynamodb:Scan", "dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniWSConnections"
    },
    {
      "Sid": "PushToWebSocketClients",
      "Effect": "Allow",
      "Action": ["execute-api:ManageConnections"],
      "Resource": "arn:aws:execute-api:ap-southeast-1:<ACCOUNT_ID>:<WS_API_ID>/prod/POST/@connections/*"
    }
  ]
}
```

### `omni-ws-role`
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ManageConnectionRecords",
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniWSConnections"
    },
    {
      "Sid": "ConsumeWebSocketTicket",
      "Effect": "Allow",
      "Action": ["dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniIdempotency"
    }
  ]
}
```

### `omni-outbound-role`
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadTelegramToken",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter"],
      "Resource": "arn:aws:ssm:ap-southeast-1:<ACCOUNT_ID>:parameter/omniinbox/prod/telegram_bot_token"
    },
    {
      "Sid": "ConversationsReadUpdate",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:UpdateItem"],
      "Resource": "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniConversations"
    },
    {
      "Sid": "MessagesReadWrite",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
      "Resource": "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniMessages"
    },
    {
      "Sid": "BroadcastConnectionsOnly",
      "Effect": "Allow",
      "Action": ["dynamodb:Scan", "dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniWSConnections"
    },
    {
      "Sid": "PushToWebSocketClients",
      "Effect": "Allow",
      "Action": ["execute-api:ManageConnections"],
      "Resource": "arn:aws:execute-api:ap-southeast-1:<ACCOUNT_ID>:<WS_API_ID>/prod/POST/@connections/*"
    }
  ]
}
```

### `omni-ai-role` *(chỉ tạo nếu Go Pha 2)*
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadRecentMessages",
      "Effect": "Allow",
      "Action": ["dynamodb:Query"],
      "Resource": "arn:aws:dynamodb:ap-southeast-1:<ACCOUNT_ID>:table/OmniMessages"
    },
    {
      "Sid": "InvokeSelectedModelOnly",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel"],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/<MODEL_ID>",
        "arn:aws:bedrock:ap-southeast-1:<ACCOUNT_ID>:inference-profile/<INFERENCE_PROFILE_ID>"
      ]
    }
  ]
}
```

> Ngoài ra cần `omni-apigw-cloudwatch-role` (`AmazonAPIGatewayPushToCloudWatchLogs`) để API Gateway đẩy log. Nếu tài khoản lab không cho tạo Role tùy chỉnh, ghi trung thực tên role thực tế đang dùng vào báo cáo cuối kỳ.

---

## 5. Thứ tự Clean-up sau khi hoàn tất chấm điểm

> Chỉ thực hiện clean-up trên tài nguyên thật **sau khi** đã chấm điểm xong và xuất đủ ảnh/log/video minh chứng.

1. Telegram `deleteWebhook` và `/revoke` token trên `@BotFather`.
2. Disable & Delete CloudFront → xóa OAC → Empty & Delete S3 bucket.
3. Xóa API Gateway (`REST` và `WebSocket`) + gỡ CloudWatch log role ARN trong Settings.
4. Xóa 5 (+1) Lambda Functions → xóa 2 queue SQS → xóa 4 bảng DynamoDB.
5. Xóa CloudWatch Alarms, Metric Filter, mọi Log Group `/aws/lambda/omni-*` và `/aws/apigateway/omni-*`, SNS topic `omni-alert-topic`.
6. Xóa Cognito User Pool, 2 tham số SSM, 6+1 IAM Roles và AWS Budget `OmniInbox-Monthly-Cost-Budget`.
7. Sau 24–48 giờ kiểm tra lại Cost Explorer & Resource Tag Editor (cả `ap-southeast-1` và `us-east-1`).
