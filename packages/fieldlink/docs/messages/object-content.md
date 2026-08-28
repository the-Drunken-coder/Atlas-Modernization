# Object-content message

Object content is FieldLink message ID 6 and defaults to bulk priority. It
carries raw bytes separately from Resource's Atlas Object metadata.

```ts
{
  type: "object-content",
  object_id: "object-1",
  content_type: "application/json",
  content: Uint8Array.from(...),
}
```

The binary codec writes a two-byte header length, a small UTF-8 JSON header,
and the exact content bytes. It does not base64-encode the content. Text, JSON,
XML, images, and sensor matrices are all byte content and use the same message.

The complete encoded message remains bounded to 1 MiB. Larger content must be
split into multiple Atlas Objects by the application. FieldLink's normal
fragment digest, receipts, selective repair, and completion protect one
addressed Object-content transfer. The message does not recover across process
restart.

Any Asset may send Object content to the gateway without a separate grant.
FieldLink does not pause bulk content in response to congestion. The frame
scheduler still reconsiders priority between every MeshCore frame, so pending
Task and Runtime traffic can run before later bulk frames. The current Atlas SDK
supports Object-content download but not upload. FieldLink therefore delivers
received bytes to the application listener and makes no claim that Core stored
them. Atlas upload integration remains unimplemented.
