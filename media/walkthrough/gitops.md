## Manage JetStream as code

**Export JetStream Config to Workspace** writes `NAME.stream.json`, `STREAM.CONSUMER.consumer.json` and `BUCKET.kv.json` files, compatible with `nats stream add --config`. JSON schemas provide validation and hover docs for every field.

CodeLens on those files lets you **Compare** with the server (detect drift) and **Apply** changes. **Plan & Apply Folder** shows a terraform-style plan before changing anything.
