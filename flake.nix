{
  description = "Celine — a Telegram profile companion";

  inputs = {
    # Archive URLs must use commits: branch archives can change without updating flake.lock.
    # To update an input, replace its revision and run nix flake lock.
    nixpkgs.url = "https://github.com/NixOS/nixpkgs/archive/2074cc672349f14240fb7ea90d509e0b643e9dd4.tar.gz"; # nixpkgs-unstable
    nixpkgs-darwin.url = "https://github.com/NixOS/nixpkgs/archive/f4244ef33645badc8157562b5e80748929b396c2.tar.gz"; # nixpkgs-26.05-darwin
    rust-overlay = {
      url = "https://github.com/oxalica/rust-overlay/archive/84edd48f141b0c8910dffdd0296ddd577e829132.tar.gz"; # master
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
        pkgs.callPackage ./nix/package.nix { inherit rustPlatform; };
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
