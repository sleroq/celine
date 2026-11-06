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
      BUN_CONFIG_MAX_HTTP_REQUESTS=8 bun install --frozen-lockfile --ignore-scripts --os='*' --cpu='*'
    '';
    installPhase = ''
      cp -R node_modules "$out"
    '';
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-N6Bq2XxESxsYUHJQWkUpbDr19afOY3eG8gzL/t0Mcr0=";
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
  '';
  doCheck = true;
  passthru = { inherit webDependencies; };
  meta = {
    description = "Telegram profile companion";
    mainProgram = "celine";
    platforms = lib.platforms.unix;
  };
}
