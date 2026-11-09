<img src="assets/logo.gif" alt="Celine logo" width="160">

# Celine

Update your telegram profile automatically on schedule. Configure presets, update image / status / style together or on separate schedules.

Check out [Demo](https://celine.cum.army)

![Celine profile photos, appearance editor, and appearance presets](assets/pic.jpg)

## Features

- Rotation for profile pictures
- Rotation for statuss
- Rotation for profile / message style
- Multiple accounts
- Link status / style to the profile picture to rotate it together, allowing for matching status / style
- Edit / crop pictures
- Change order or rotate randomly
- Configure custom jitter between rotations
- Reuse already uploaded pictures and continue rotation where last left off

## Get started

1. Obtain your own API credentials at <https://my.telegram.org/apps>, then:

2. Fill out env file from the example: `cp .env.example .env`

2. Download and run the binary for your platform:
    - [macOS ARM64](https://github.com/sleroq/celine/releases/latest/download/celine-aarch64-apple-darwin)
    - [Windows x64](https://github.com/sleroq/celine/releases/latest/download/celine-x86_64-pc-windows-msvc.exe)

    Other platforms are available on [Releases](../../releases).

    Or run via nix / docker (instructions below)


## Run with Nix

```sh
nix run github:sleroq/celine
```

## Run with Docker (Linux)


```sh
docker compose up -d --build
```

For production deployments on the servers, attach UI via ssh tunnel. Avoid exposing UI publicly:

```sh
ssh -N -L 7766:127.0.0.1:7766 user@server
```
