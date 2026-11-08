{
  lib,
  stdenvNoCC,
  bun,
  rustPlatform,
  # Optional build-time credentials are readable in the binary and Nix store.
  apiId ? null,
  apiHash ? null,
}:
let
  webDependencies = stdenvNoCC.mkDerivation {
    pname = "celine-web-dependencies";
    version = "0.1.0";
    src = lib.fileset.toSource {
      root = ../web;
      fileset = lib.fileset.unions [
        ../web/package.json
        ../web/bun.lock
      ];
    };
    nativeBuildInputs = [ bun ];
    dontConfigure = true;
    dontFixup = true;
    buildPhase = ''
      export HOME="$TMPDIR"
      # Linux Bun filters musl packages; the older Intel macOS Bun lacks --libc.
      BUN_CONFIG_MAX_HTTP_REQUESTS=8 bun install --frozen-lockfile --ignore-scripts --os='*' --cpu='*' ${lib.optionalString stdenvNoCC.hostPlatform.isLinux "--libc='*'"}
    '';
    installPhase = ''
      cp -R node_modules "$out"
    '';
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-8rbdZRaN6rTjFEvfggQv9lh08SDe7/d7VUlOYvjv26c=";
  };
in
rustPlatform.buildRustPackage {
  pname = "celine";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../build.rs
      ../src
      (lib.fileset.maybeMissing ../tests)
      (lib.fileset.difference ../web (
        lib.fileset.unions [
          (lib.fileset.maybeMissing ../web/node_modules)
          (lib.fileset.maybeMissing ../web/dist)
        ]
      ))
    ];
  };
  cargoLock.lockFile = ../Cargo.lock;
  nativeBuildInputs = [ bun ];
  env =
    lib.optionalAttrs (apiId != null) { CELINE_API_ID = toString apiId; }
    // lib.optionalAttrs (apiHash != null) { CELINE_API_HASH = apiHash; };
  preBuild = ''
    cp -R ${webDependencies} web/node_modules
    chmod -R u+w web/node_modules
    # Linux sandboxes do not provide /usr/bin/env for these Bun-invoked scripts.
    substituteInPlace web/node_modules/typescript/bin/tsc web/node_modules/vite/bin/vite.js \
      --replace-fail '#!/usr/bin/env node' '#!${lib.getExe bun}'
  '';
  doCheck = true;
  passthru = { inherit webDependencies; };
  meta = {
    description = "Telegram profile companion";
    mainProgram = "celine";
    platforms = lib.platforms.unix;
  };
}
