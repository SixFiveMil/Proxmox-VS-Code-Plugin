import * as vscode from 'vscode';
import { ProxmoxClient, type ProxmoxVm } from './proxmoxClient';

type ExplorerItemKind = 'node' | 'vm' | 'snapshot' | 'error' | 'empty';

type ExplorerItemData = {
	nodeName?: string;
	vm?: ProxmoxVm;
	snapshotName?: string;
	snapshotTime?: number | null;
};

export class ProxmoxExplorerItem extends vscode.TreeItem {
	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly kind: ExplorerItemKind,
		public readonly data?: ExplorerItemData
	) {
		super(label, collapsibleState);
		this.contextValue = `proxmox.${kind}`;
	}
}

export class ProxmoxExplorerProvider implements vscode.TreeDataProvider<ProxmoxExplorerItem> {
	private readonly emitter = new vscode.EventEmitter<ProxmoxExplorerItem | undefined | null | void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly getClient: () => Promise<ProxmoxClient | null>) {}

	refresh(): void {
		this.emitter.fire();
	}

	getTreeItem(element: ProxmoxExplorerItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: ProxmoxExplorerItem): Promise<ProxmoxExplorerItem[]> {
		try {
			const client = await this.getClient();
			if (!client) {
				return [
					new ProxmoxExplorerItem(
						'Configure Proxmox settings to load data',
						vscode.TreeItemCollapsibleState.None,
						'empty'
					)
				];
			}

			if (!element) {
				const nodes = await client.listNodes();
				if (nodes.length === 0) {
					return [
						new ProxmoxExplorerItem('No nodes found', vscode.TreeItemCollapsibleState.None, 'empty')
					];
				}

				return nodes.map((node) => {
					const item = new ProxmoxExplorerItem(
						node.name,
						vscode.TreeItemCollapsibleState.Collapsed,
						'node',
						{ nodeName: node.name }
					);
					item.description = node.status;
					item.iconPath = new vscode.ThemeIcon('server');
					return item;
				});
			}

			if (element.kind === 'node' && element.data?.nodeName) {
				const vms = await client.listVirtualMachines(element.data.nodeName);
				if (vms.length === 0) {
					return [
						new ProxmoxExplorerItem('No VMs found', vscode.TreeItemCollapsibleState.None, 'empty')
					];
				}

				return vms.map((vm) => {
					const item = new ProxmoxExplorerItem(
						`${vm.name} (${vm.id})`,
						vscode.TreeItemCollapsibleState.Collapsed,
						'vm',
						{ nodeName: vm.node, vm }
					);
					item.description = `${vm.type.toUpperCase()} • ${vm.status}`;
					item.iconPath = new vscode.ThemeIcon(vm.type === 'qemu' ? 'desktop-download' : 'container');
					return item;
				});
			}

			if (element.kind === 'vm' && element.data?.vm) {
				const vm = element.data.vm;
				const snapshots = await client.listSnapshots(vm.node, vm.type, vm.id);
				if (snapshots.length === 0) {
					return [
						new ProxmoxExplorerItem('No snapshots', vscode.TreeItemCollapsibleState.None, 'empty')
					];
				}

				return snapshots.map((snapshot) => {
					const item = new ProxmoxExplorerItem(
						snapshot.name,
						vscode.TreeItemCollapsibleState.None,
						'snapshot',
						{
							snapshotName: snapshot.name,
							snapshotTime: snapshot.createdAt,
							vm
						}
					);
					item.description = snapshot.createdAt ? new Date(snapshot.createdAt * 1000).toLocaleString() : undefined;
					item.iconPath = new vscode.ThemeIcon('history');
					return item;
				});
			}

			return [];
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const item = new ProxmoxExplorerItem(
				'Failed to load Proxmox data',
				vscode.TreeItemCollapsibleState.None,
				'error'
			);
			item.description = message;
			item.iconPath = new vscode.ThemeIcon('error');
			return [item];
		}
	}
}
