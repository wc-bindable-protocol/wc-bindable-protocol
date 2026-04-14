import { bootstrapS3 } from "../../dist/index.js";

bootstrapS3({
  remote: { enableRemote: true, remoteSettingType: "env" },
});
