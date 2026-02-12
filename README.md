# Proxmox VS Code

A VS Code extension to interact with Proxmox VE from the editor. The initial scaffold provides a simple command and is ready for integrating Proxmox workflows like listing nodes, managing VMs, and automating development environments.

## Features

- Command entry point for Proxmox-related actions.
- Ready for API integration (authentication, node listing, VM lifecycle).
- Explorer view for nodes, VMs, and snapshots.
- Extension debugging setup via VS Code launch configuration.

## Requirements

- Access to a Proxmox VE host.
- A Proxmox API token or user credentials (how you store and use these will be defined in future updates).
- API token permissions for:
	- Node listing: `Sys.Audit` on `/` or `/nodes/<node>`.
	- VM/CT inventory and details: `VM.Audit` on `/vms` or the target node/VM path.
	- VM lifecycle actions: `VM.PowerMgmt` on the target node/VM path.
	- If token privilege separation is enabled, permissions must be granted to the token itself.

## Usage

1. Run the extension in a new Extension Development Host window (press `F5`).
2. Configure `proxmox.host` in Settings.
3. Run `Proxmox: Set API Token` to store the token securely in VS Code Secret Storage.
4. Run `Proxmox: Clear API Token` if you need to remove the stored token.
5. Run `Proxmox: Test Connection` to validate access.
6. Run `Proxmox: List VMs` to browse QEMU and LXC guests per node, with optional filters (QEMU-only, LXC-only, running-only).
7. Run `Proxmox: VM Actions` to view details or start/stop a selected VM.
8. Run `Proxmox: Snapshot Actions` to list, create, restore, or delete snapshots.
9. Run `Proxmox: Create Snapshot` to create a snapshot directly using the template.
10. Run `Proxmox: Restore Snapshot` to restore a snapshot directly.
11. Use the Explorer view to browse nodes, VMs, and snapshots, and run `Proxmox: Refresh Explorer` to reload.
12. If you dismissed the insecure TLS warning, run `Proxmox: Reset Insecure Warning` to show it again.
13. Replace the sample command implementation with Proxmox actions as you build them.

## Extension Settings

This extension contributes the following settings:

- `proxmox.host`: Proxmox API base URL, for example `https://proxmox.example:8006`.
- `proxmox.apiToken`: Deprecated. Use `Proxmox: Set API Token` to store the token securely.
- `proxmox.allowInsecure`: When enabled, allows self-signed TLS certificates. The extension shows a warning the first time this is used and you can choose "Don't show again" to suppress future warnings.
- `proxmox.confirmStart`: Require confirmation before starting a VM or container.
- `proxmox.confirmStop`: Require confirmation before stopping a VM or container.
- `proxmox.confirmRestart`: Require confirmation before restarting a VM or container.
- `proxmox.snapshotTemplate`: Snapshot name template, default `snapshot-YYYYMMDD-HHMM`.

## Keybindings

- `Proxmox: Reset Insecure Warning`: Suggested keybinding `Ctrl+Alt+P Ctrl+R` (macOS: `Cmd+Alt+P Cmd+R`).

## Known Issues

- Proxmox API operations are not implemented yet.

## Release Notes

### 0.0.1

- Initial scaffold with a sample command.
