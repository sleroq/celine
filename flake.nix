{
  description = "Celine — a Telegram profile companion";

  inputs = {
    nixpkgs.url = "https://github.com/NixOS/nixpkgs/archive/nixpkgs-unstable.tar.gz";
    nixpkgs-darwin.url = "https://github.com/NixOS/nixpkgs/archive/nixpkgs-26.05-darwin.tar.gz";
    rust-overlay = {
      url = "https://github.com/oxalica/rust-overlay/archive/master.tar.gz";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      nixpkgs-darwin,
      rust-overlay,
      ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor =
        system:
        import (if system == "x86_64-darwin" then nixpkgs-darwin else nixpkgs) {
          inherit system;
          overlays = [ rust-overlay.overlays.default ];
        };
      toolchainFor =
        pkgs:
        pkgs.rust-bin.stable.${(builtins.fromTOML (builtins.readFile ./rust-toolchain.toml)).toolchain.channel}.default;
      packageFor =
        pkgs:
        let
          rust = toolchainFor pkgs;
          rustPlatform = pkgs.makeRustPlatform {
            cargo = rust;
            rustc = rust;
          };
        in
        rustPlatform.buildRustPackage {
          pname = "celine";
          version = "0.1.0";
          src = pkgs.lib.cleanSource ./.;
          cargoLock.lockFile = ./Cargo.lock;
          meta = {
            description = "Telegram profile companion";
            mainProgram = "celine";
            platforms = pkgs.lib.platforms.unix;
          };
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          package = packageFor (pkgsFor system);
        in
        {
          default = package;
          celine = package;
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              (toolchainFor pkgs)
              pkgs.bun
            ];
          };
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt);
    };
}
