import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["t3code", "T3 Code (Alpha)", "t3code-v2"])(
  "never adopts the %s profile on Windows",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "oh-profile-" });
      const source = path.join(directory, sourceName);
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), '{"os_crypt":{}}');
      const userData = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(userData, path.join(directory, "open-harness"));
      assert.isFalse(yield* fs.exists(path.join(userData, "Local State")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
