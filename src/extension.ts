// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ProxmoxClient, type ProxmoxVm } from './proxmoxClient';
import { ProxmoxExplorerItem, ProxmoxExplorerProvider } from './proxmoxExplorer';

type VmPickItem = vscode.QuickPickItem & { vm: ProxmoxVm };
type FilterPickItem = vscode.QuickPickItem & { key: 'qemu' | 'lxc' | 'running' };
type ActionPickItem = vscode.QuickPickItem & { action: 'details' | 'start' | 'stop' | 'restart' };
type SnapshotActionPickItem = vscode.QuickPickItem & { action: 'list' | 'create' | 'delete' | 'restore' };

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "proxmox-vs-code" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('proxmox-vs-code.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from Proxmox VS Code!');
	});

	const statusItem = vscode.window.createStatusBarItem('proxmox-vs-code.status', vscode.StatusBarAlignment.Left, 100);
	let statusState: 'unknown' | 'connecting' | 'connected' | 'disconnected' = 'unknown';
	let lastRefresh: Date | null = null;
	let lastError: string | null = null;

	const updateStatusBar = () => {
		let icon = '$(question)';
		let stateLabel = 'Not checked';

		switch (statusState) {
			case 'connecting':
				icon = '$(sync~spin)';
				stateLabel = 'Connecting';
				break;
			case 'connected':
				icon = '$(plug)';
				stateLabel = 'Connected';
				break;
			case 'disconnected':
				icon = '$(circle-slash)';
				stateLabel = 'Disconnected';
				break;
			default:
				break;
		}

		const refreshLabel = lastRefresh ? lastRefresh.toLocaleString() : 'Never';
		const errorLabel = lastError ? `\nLast error: ${lastError}` : '';
		statusItem.text = `${icon} Proxmox`;
		statusItem.tooltip = `Proxmox: ${stateLabel}\nLast refresh: ${refreshLabel}${errorLabel}`;
	};

	statusItem.name = 'Proxmox';
	statusItem.command = 'proxmox-vs-code.listNodes';
	updateStatusBar();
	statusItem.show();

	const explorerProvider = new ProxmoxExplorerProvider(() => createClient(false));
	const explorerView = vscode.window.createTreeView('proxmoxExplorerView', { treeDataProvider: explorerProvider });

	const markConnected = () => {
		statusState = 'connected';
		lastRefresh = new Date();
		lastError = null;
		updateStatusBar();
	};

	const markDisconnected = (errorMessage: string) => {
		statusState = 'disconnected';
		lastRefresh = new Date();
		lastError = errorMessage;
		updateStatusBar();
	};

	const createClient = async (interactive: boolean): Promise<ProxmoxClient | null> => {
		const config = vscode.workspace.getConfiguration('proxmox');
		const host = config.get<string>('host', '');
		const allowInsecure = config.get<boolean>('allowInsecure', false);
		const apiToken = await getApiToken(interactive);

		if (!host.trim()) {
			if (interactive) {
				vscode.window.showErrorMessage('Proxmox host is not configured.');
			}
			return null;
		}

		if (!apiToken) {
			return null;
		}

		if (interactive && allowInsecure) {
			const suppressWarning = context.globalState.get<boolean>('proxmox.suppressInsecureWarning', false);
			if (!suppressWarning) {
				const choice = await vscode.window.showWarningMessage(
					'Allow insecure TLS is enabled for Proxmox. This skips certificate validation.',
					'Continue',
					"Don't show again"
				);

				if (choice === "Don't show again") {
					await context.globalState.update('proxmox.suppressInsecureWarning', true);
				}

				if (choice !== 'Continue') {
					statusState = 'unknown';
					updateStatusBar();
					return null;
				}
			}
		}

		return new ProxmoxClient({ host, apiToken, allowInsecure });
	};

	const getApiToken = async (interactive: boolean): Promise<string | null> => {
		const storedToken = await context.secrets.get('proxmox.apiToken');
		if (storedToken) {
			return storedToken;
		}

		const config = vscode.workspace.getConfiguration('proxmox');
		const legacyToken = config.get<string>('apiToken', '').trim();
		if (legacyToken) {
			if (interactive) {
				const choice = await vscode.window.showWarningMessage(
					'API token is set in settings. Move it to Secret Storage?',
					'Move',
					'Use Once'
				);

				if (choice === 'Move') {
					await context.secrets.store('proxmox.apiToken', legacyToken);
					vscode.window.showInformationMessage('Proxmox API token saved in Secret Storage.');
					return legacyToken;
				}

				if (choice === 'Use Once') {
					return legacyToken;
				}
			} else {
				return legacyToken;
			}
		}

		if (interactive) {
			vscode.window.showErrorMessage('Proxmox API token is not configured. Run Proxmox: Set API Token.');
		}

		return null;
	};

	const selectNode = async (client: ProxmoxClient): Promise<string | null> => {
		const nodes = await client.listNodes();
		if (nodes.length === 0) {
			markConnected();
			vscode.window.showInformationMessage('No Proxmox nodes found.');
			return null;
		}

		const nodeSelection = await vscode.window.showQuickPick(
			nodes.map((node) => ({ label: node.name, description: node.status })),
			{ placeHolder: 'Select a Proxmox node' }
		);

		return nodeSelection?.label ?? null;
	};

	const selectVmFilters = async (): Promise<{ includeQemu: boolean; includeLxc: boolean; runningOnly: boolean } | null> => {
		const filterItems: FilterPickItem[] = [
			{ label: 'QEMU', description: 'Include QEMU virtual machines', key: 'qemu' },
			{ label: 'LXC', description: 'Include LXC containers', key: 'lxc' },
			{ label: 'Running only', description: 'Only show running guests', key: 'running' }
		];

		const filterSelection = await vscode.window.showQuickPick(filterItems, {
			canPickMany: true,
			placeHolder: 'Select VM filters (optional)'
		});

		if (!filterSelection) {
			return null;
		}

		const keys = new Set(filterSelection.map((item) => item.key));
		const includeQemu = keys.has('qemu');
		const includeLxc = keys.has('lxc');
		return {
			includeQemu: includeQemu || (!includeQemu && !includeLxc),
			includeLxc: includeLxc || (!includeQemu && !includeLxc),
			runningOnly: keys.has('running')
		};
	};

	const filterVms = (
		vms: ProxmoxVm[],
		filters: { includeQemu: boolean; includeLxc: boolean; runningOnly: boolean }
	): ProxmoxVm[] =>
		vms.filter((vm) => {
			const typeMatch = (filters.includeQemu && vm.type === 'qemu') || (filters.includeLxc && vm.type === 'lxc');
			const statusMatch = !filters.runningOnly || vm.status === 'running';
			return typeMatch && statusMatch;
		});

	const buildVmPickItems = (vms: ProxmoxVm[]): VmPickItem[] =>
		vms.map((vm) => ({
			label: `${vm.name} (${vm.id})`,
			description: `${vm.type.toUpperCase()} • ${vm.status}`,
			vm
		}));

	const formatBytes = (value: number): string => {
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let size = value;
		let unitIndex = 0;

		while (size >= 1024 && unitIndex < units.length - 1) {
			size /= 1024;
			unitIndex += 1;
		}

		return `${size.toFixed(1)} ${units[unitIndex]}`;
	};

	const formatUptime = (seconds: number): string => {
		const days = Math.floor(seconds / 86400);
		const hours = Math.floor((seconds % 86400) / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
	};

	const formatSnapshotTime = (timestamp: number | null): string =>
		timestamp ? new Date(timestamp * 1000).toLocaleString() : 'Unknown';

	const generateSnapshotName = (template: string, timestamp = new Date()): string => {
		const pad2 = (value: number) => value.toString().padStart(2, '0');
		const year = timestamp.getFullYear().toString();
		const month = pad2(timestamp.getMonth() + 1);
		const day = pad2(timestamp.getDate());
		const hour = pad2(timestamp.getHours());
		const minute = pad2(timestamp.getMinutes());

		return template
			.replace(/HHMM/g, `${hour}${minute}`)
			.replace(/YYYY/g, year)
			.replace(/MM/g, month)
			.replace(/DD/g, day)
			.replace(/HH/g, hour)
			.replace(/mm/g, minute);
	};

	const confirmVmAction = async (
		actionLabel: string,
		vm: ProxmoxVm,
		settingKey: 'confirmStart' | 'confirmStop' | 'confirmRestart'
	): Promise<boolean> => {
		const config = vscode.workspace.getConfiguration('proxmox');
		const shouldConfirm = config.get<boolean>(settingKey, true);
		if (!shouldConfirm) {
			return true;
		}

		const choice = await vscode.window.showWarningMessage(
			`${actionLabel} ${vm.name} (${vm.id})?`,
			{ modal: true },
			'Confirm'
		);

		return choice === 'Confirm';
	};

	const getVmFromExplorerItem = (item: ProxmoxExplorerItem | undefined): ProxmoxVm | null => {
		if (item?.data?.vm) {
			return item.data.vm;
		}

		return null;
	};

	const refreshNodes = async (interactive: boolean) => {
		try {
			statusState = 'connecting';
			updateStatusBar();
			const client = await createClient(interactive);
			if (!client) {
				return;
			}
			const nodes = await client.listNodes();
			markConnected();

			if (!interactive) {
				return;
			}

			if (nodes.length === 0) {
				vscode.window.showInformationMessage('No Proxmox nodes found.');
				return;
			}

			const pickItems = nodes.map((node) => `${node.name} (${node.status})`);
			const selection = await vscode.window.showQuickPick(pickItems, {
				placeHolder: 'Select a Proxmox node'
			});

			if (selection) {
				vscode.window.showInformationMessage(`Selected node: ${selection}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			markDisconnected(message);

			if (interactive) {
				vscode.window.showErrorMessage(`Failed to list Proxmox nodes: ${message}`);
			}
		}
	};

	const listNodesDisposable = vscode.commands.registerCommand('proxmox-vs-code.listNodes', async () => {
		await refreshNodes(true);
	});

	const listVmsDisposable = vscode.commands.registerCommand('proxmox-vs-code.listVms', async () => {
		try {
			statusState = 'connecting';
			updateStatusBar();

			const client = await createClient(true);
			if (!client) {
				return;
			}

			const nodeName = await selectNode(client);
			if (!nodeName) {
				return;
			}

			const filters = await selectVmFilters();
			if (!filters) {
				return;
			}

			const vms = await client.listVirtualMachines(nodeName);
			markConnected();
			const filteredVms = filterVms(vms, filters);
			if (filteredVms.length === 0) {
				vscode.window.showInformationMessage(`No VMs found on ${nodeName} with the selected filters.`);
				return;
			}

			const vmSelection = await vscode.window.showQuickPick(buildVmPickItems(filteredVms), {
				placeHolder: 'Select a VM'
			});

			if (vmSelection) {
				vscode.window.showInformationMessage(`Selected VM: ${vmSelection.label}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			markDisconnected(message);
			vscode.window.showErrorMessage(`Failed to list Proxmox VMs: ${message}`);
		}
	});

	const vmActionDisposable = vscode.commands.registerCommand('proxmox-vs-code.vmAction', async () => {
		try {
			statusState = 'connecting';
			updateStatusBar();

			const client = await createClient(true);
			if (!client) {
				return;
			}

			const nodeName = await selectNode(client);
			if (!nodeName) {
				return;
			}

			const filters = await selectVmFilters();
			if (!filters) {
				return;
			}

			const vms = await client.listVirtualMachines(nodeName);
			const filteredVms = filterVms(vms, filters);
			if (filteredVms.length === 0) {
				markConnected();
				vscode.window.showInformationMessage(`No VMs found on ${nodeName} with the selected filters.`);
				return;
			}

			const vmSelection = await vscode.window.showQuickPick(buildVmPickItems(filteredVms), {
				placeHolder: 'Select a VM to manage'
			});

			if (!vmSelection) {
				return;
			}

			const actionItems: ActionPickItem[] = [
				{ label: 'Open Details', action: 'details' },
				{ label: 'Start VM', action: 'start' },
				{ label: 'Stop VM', action: 'stop' },
				{ label: 'Restart VM', action: 'restart' }
			];

			const actionSelection = await vscode.window.showQuickPick(actionItems, {
				placeHolder: 'Select an action'
			});

			if (!actionSelection) {
				return;
			}

			const vm = vmSelection.vm;
			switch (actionSelection.action) {
				case 'details': {
					const details = await client.getVirtualMachineDetails(vm.node, vm.type, vm.id);
					markConnected();
					const memory = details.maxMem > 0 ? `${formatBytes(details.mem)} / ${formatBytes(details.maxMem)}` : 'Unknown';
					const message = [
						`${details.name} (${details.id})`,
						`Type: ${details.type.toUpperCase()}`,
						`Status: ${details.status}`,
						`Uptime: ${formatUptime(details.uptime)}`,
						`CPU: ${(details.cpu * 100).toFixed(1)}%`,
						`Memory: ${memory}`
					].join('\n');
					vscode.window.showInformationMessage(message);
					break;
				}
				case 'start':
					if (!(await confirmVmAction('Start', vm, 'confirmStart'))) {
						return;
					}
					await client.startVirtualMachine(vm.node, vm.type, vm.id);
					markConnected();
					vscode.window.showInformationMessage(`Started ${vm.name} (${vm.id}).`);
					break;
				case 'stop':
					if (!(await confirmVmAction('Stop', vm, 'confirmStop'))) {
						return;
					}
					await client.stopVirtualMachine(vm.node, vm.type, vm.id);
					markConnected();
					vscode.window.showInformationMessage(`Stopped ${vm.name} (${vm.id}).`);
					break;
				case 'restart':
					if (!(await confirmVmAction('Restart', vm, 'confirmRestart'))) {
						return;
					}
					await client.restartVirtualMachine(vm.node, vm.type, vm.id);
					markConnected();
					vscode.window.showInformationMessage(`Restarted ${vm.name} (${vm.id}).`);
					break;
				default:
					break;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			markDisconnected(message);
			vscode.window.showErrorMessage(`Failed to manage Proxmox VM: ${message}`);
		}
	});

	const snapshotActionDisposable = vscode.commands.registerCommand('proxmox-vs-code.snapshotActions', async () => {
		try {
			statusState = 'connecting';
			updateStatusBar();

			const client = await createClient(true);
			if (!client) {
				return;
			}

			const nodeName = await selectNode(client);
			if (!nodeName) {
				return;
			}

			const filters = await selectVmFilters();
			if (!filters) {
				return;
			}

			const vms = await client.listVirtualMachines(nodeName);
			const filteredVms = filterVms(vms, filters);
			if (filteredVms.length === 0) {
				markConnected();
				vscode.window.showInformationMessage(`No VMs found on ${nodeName} with the selected filters.`);
				return;
			}

			const vmSelection = await vscode.window.showQuickPick(buildVmPickItems(filteredVms), {
				placeHolder: 'Select a VM or container'
			});

			if (!vmSelection) {
				return;
			}

			const snapshotActions: SnapshotActionPickItem[] = [
				{ label: 'List Snapshots', action: 'list' },
				{ label: 'Create Snapshot', action: 'create' },
				{ label: 'Restore Snapshot', action: 'restore' },
				{ label: 'Delete Snapshot', action: 'delete' }
			];

			const actionSelection = await vscode.window.showQuickPick(snapshotActions, {
				placeHolder: 'Select a snapshot action'
			});

			if (!actionSelection) {
				return;
			}

			const vm = vmSelection.vm;
			switch (actionSelection.action) {
				case 'list': {
					const snapshots = await client.listSnapshots(vm.node, vm.type, vm.id);
					markConnected();
					if (snapshots.length === 0) {
						vscode.window.showInformationMessage('No snapshots found.');
						return;
					}

					const snapshotPick = await vscode.window.showQuickPick(
						snapshots.map((snapshot) => ({
							label: snapshot.name,
							description: formatSnapshotTime(snapshot.createdAt)
						})),
						{ placeHolder: 'Snapshots' }
					);

					if (snapshotPick) {
						vscode.window.showInformationMessage(`Snapshot: ${snapshotPick.label}`);
					}
					break;
				}
				case 'create': {
					const config = vscode.workspace.getConfiguration('proxmox');
					const template = config.get<string>('snapshotTemplate', 'snapshot-YYYYMMDD-HHMM');
					const snapshotName = generateSnapshotName(template);
					await client.createSnapshot(vm.node, vm.type, vm.id, snapshotName);
					markConnected();
					vscode.window.showInformationMessage(`Created snapshot ${snapshotName}.`);
					break;
				}
				case 'delete': {
					const snapshots = await client.listSnapshots(vm.node, vm.type, vm.id);
					if (snapshots.length === 0) {
						markConnected();
						vscode.window.showInformationMessage('No snapshots found.');
						return;
					}

					const snapshotPick = await vscode.window.showQuickPick(
						snapshots.map((snapshot) => ({
							label: snapshot.name,
							description: formatSnapshotTime(snapshot.createdAt)
						})),
						{ placeHolder: 'Select a snapshot to delete' }
					);

					if (!snapshotPick) {
						return;
					}

					const confirmDelete = await vscode.window.showWarningMessage(
						`Delete snapshot ${snapshotPick.label}?`,
						{ modal: true },
						'Delete'
					);

					if (confirmDelete !== 'Delete') {
						return;
					}

					await client.deleteSnapshot(vm.node, vm.type, vm.id, snapshotPick.label);
					markConnected();
					vscode.window.showInformationMessage(`Deleted snapshot ${snapshotPick.label}.`);
					break;
				}
				case 'restore': {
					const snapshots = await client.listSnapshots(vm.node, vm.type, vm.id);
					if (snapshots.length === 0) {
						markConnected();
						vscode.window.showInformationMessage('No snapshots found.');
						return;
					}

					const snapshotPick = await vscode.window.showQuickPick(
						snapshots.map((snapshot) => ({
							label: snapshot.name,
							description: formatSnapshotTime(snapshot.createdAt)
						})),
						{ placeHolder: 'Select a snapshot to restore' }
					);

					if (!snapshotPick) {
						return;
					}

					const confirmRestore = await vscode.window.showWarningMessage(
						`Restore snapshot ${snapshotPick.label}?`,
						{ modal: true },
						'Restore'
					);

					if (confirmRestore !== 'Restore') {
						return;
					}

					await client.restoreSnapshot(vm.node, vm.type, vm.id, snapshotPick.label);
					markConnected();
					vscode.window.showInformationMessage(`Restored snapshot ${snapshotPick.label}.`);
					break;
				}
				default:
					break;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			markDisconnected(message);
			vscode.window.showErrorMessage(`Failed to manage snapshots: ${message}`);
		}
	});

	const restoreSnapshotDisposable = vscode.commands.registerCommand('proxmox-vs-code.restoreSnapshot', async () => {
		try {
			statusState = 'connecting';
			updateStatusBar();

			const client = await createClient(true);
			if (!client) {
				return;
			}

			const nodeName = await selectNode(client);
			if (!nodeName) {
				return;
			}

			const filters = await selectVmFilters();
			if (!filters) {
				return;
			}

			const vms = await client.listVirtualMachines(nodeName);
			const filteredVms = filterVms(vms, filters);
			if (filteredVms.length === 0) {
				markConnected();
				vscode.window.showInformationMessage(`No VMs found on ${nodeName} with the selected filters.`);
				return;
			}

			const vmSelection = await vscode.window.showQuickPick(buildVmPickItems(filteredVms), {
				placeHolder: 'Select a VM or container'
			});

			if (!vmSelection) {
				return;
			}

			const snapshots = await client.listSnapshots(vmSelection.vm.node, vmSelection.vm.type, vmSelection.vm.id);
			if (snapshots.length === 0) {
				markConnected();
				vscode.window.showInformationMessage('No snapshots found.');
				return;
			}

			const snapshotPick = await vscode.window.showQuickPick(
				snapshots.map((snapshot) => ({
					label: snapshot.name,
					description: formatSnapshotTime(snapshot.createdAt)
				})),
				{ placeHolder: 'Select a snapshot to restore' }
			);

			if (!snapshotPick) {
				return;
			}

			const confirmRestore = await vscode.window.showWarningMessage(
				`Restore snapshot ${snapshotPick.label}?`,
				{ modal: true },
				'Restore'
			);

			if (confirmRestore !== 'Restore') {
				return;
			}

			await client.restoreSnapshot(vmSelection.vm.node, vmSelection.vm.type, vmSelection.vm.id, snapshotPick.label);
			markConnected();
			vscode.window.showInformationMessage(`Restored snapshot ${snapshotPick.label}.`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			markDisconnected(message);
			vscode.window.showErrorMessage(`Failed to restore snapshot: ${message}`);
		}
	});

	const createSnapshotDisposable = vscode.commands.registerCommand('proxmox-vs-code.createSnapshot', async () => {
		try {
			statusState = 'connecting';
			updateStatusBar();

			const client = await createClient(true);
			if (!client) {
				return;
			}

			const nodeName = await selectNode(client);
			if (!nodeName) {
				return;
			}

			const filters = await selectVmFilters();
			if (!filters) {
				return;
			}

			const vms = await client.listVirtualMachines(nodeName);
			const filteredVms = filterVms(vms, filters);
			if (filteredVms.length === 0) {
				markConnected();
				vscode.window.showInformationMessage(`No VMs found on ${nodeName} with the selected filters.`);
				return;
			}

			const vmSelection = await vscode.window.showQuickPick(buildVmPickItems(filteredVms), {
				placeHolder: 'Select a VM or container'
			});

			if (!vmSelection) {
				return;
			}

			const config = vscode.workspace.getConfiguration('proxmox');
			const template = config.get<string>('snapshotTemplate', 'snapshot-YYYYMMDD-HHMM');
			const snapshotName = generateSnapshotName(template);
			await client.createSnapshot(vmSelection.vm.node, vmSelection.vm.type, vmSelection.vm.id, snapshotName);
			markConnected();
			vscode.window.showInformationMessage(`Created snapshot ${snapshotName}.`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			markDisconnected(message);
			vscode.window.showErrorMessage(`Failed to create snapshot: ${message}`);
		}
	});

	const setApiTokenDisposable = vscode.commands.registerCommand('proxmox-vs-code.setApiToken', async () => {
		const token = await vscode.window.showInputBox({
			prompt: 'Enter Proxmox API token (USER@REALM!TOKEN=SECRET)',
			password: true,
			ignoreFocusOut: true
		});

		if (!token?.trim()) {
			return;
		}

		await context.secrets.store('proxmox.apiToken', token.trim());
		vscode.window.showInformationMessage('Proxmox API token saved in Secret Storage.');
	});

	const clearApiTokenDisposable = vscode.commands.registerCommand('proxmox-vs-code.clearApiToken', async () => {
		const confirm = await vscode.window.showWarningMessage(
			'Clear stored Proxmox API token?',
			{ modal: true },
			'Clear'
		);

		if (confirm !== 'Clear') {
			return;
		}

		await context.secrets.delete('proxmox.apiToken');
		vscode.window.showInformationMessage('Proxmox API token cleared.');
	});

	const testConnectionDisposable = vscode.commands.registerCommand('proxmox-vs-code.testConnection', async () => {
		try {
			statusState = 'connecting';
			updateStatusBar();
			const client = await createClient(true);
			if (!client) {
				return;
			}
			const nodes = await client.listNodes();
			markConnected();
			vscode.window.showInformationMessage(`Connected to Proxmox. Nodes: ${nodes.length}.`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			markDisconnected(message);
			vscode.window.showErrorMessage(`Proxmox connection test failed: ${message}`);
		}
	});

	const refreshExplorerDisposable = vscode.commands.registerCommand('proxmox-vs-code.refreshExplorer', () => {
		explorerProvider.refresh();
	});

	const treeStartDisposable = vscode.commands.registerCommand(
		'proxmox-vs-code.treeStartVm',
		async (item?: ProxmoxExplorerItem) => {
			const vm = getVmFromExplorerItem(item);
			if (!vm) {
				vscode.window.showErrorMessage('No VM selected.');
				return;
			}

			if (!(await confirmVmAction('Start', vm, 'confirmStart'))) {
				return;
			}

			try {
				const client = await createClient(true);
				if (!client) {
					return;
				}
				await client.startVirtualMachine(vm.node, vm.type, vm.id);
				markConnected();
				explorerProvider.refresh();
				vscode.window.showInformationMessage(`Started ${vm.name} (${vm.id}).`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				markDisconnected(message);
				vscode.window.showErrorMessage(`Failed to start VM: ${message}`);
			}
		}
	);

	const treeStopDisposable = vscode.commands.registerCommand(
		'proxmox-vs-code.treeStopVm',
		async (item?: ProxmoxExplorerItem) => {
			const vm = getVmFromExplorerItem(item);
			if (!vm) {
				vscode.window.showErrorMessage('No VM selected.');
				return;
			}

			if (!(await confirmVmAction('Stop', vm, 'confirmStop'))) {
				return;
			}

			try {
				const client = await createClient(true);
				if (!client) {
					return;
				}
				await client.stopVirtualMachine(vm.node, vm.type, vm.id);
				markConnected();
				explorerProvider.refresh();
				vscode.window.showInformationMessage(`Stopped ${vm.name} (${vm.id}).`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				markDisconnected(message);
				vscode.window.showErrorMessage(`Failed to stop VM: ${message}`);
			}
		}
	);

	const treeRestartDisposable = vscode.commands.registerCommand(
		'proxmox-vs-code.treeRestartVm',
		async (item?: ProxmoxExplorerItem) => {
			const vm = getVmFromExplorerItem(item);
			if (!vm) {
				vscode.window.showErrorMessage('No VM selected.');
				return;
			}

			if (!(await confirmVmAction('Restart', vm, 'confirmRestart'))) {
				return;
			}

			try {
				const client = await createClient(true);
				if (!client) {
					return;
				}
				await client.restartVirtualMachine(vm.node, vm.type, vm.id);
				markConnected();
				explorerProvider.refresh();
				vscode.window.showInformationMessage(`Restarted ${vm.name} (${vm.id}).`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				markDisconnected(message);
				vscode.window.showErrorMessage(`Failed to restart VM: ${message}`);
			}
		}
	);

	const treeCreateSnapshotDisposable = vscode.commands.registerCommand(
		'proxmox-vs-code.treeCreateSnapshot',
		async (item?: ProxmoxExplorerItem) => {
			const vm = getVmFromExplorerItem(item);
			if (!vm) {
				vscode.window.showErrorMessage('No VM selected.');
				return;
			}

			try {
				const client = await createClient(true);
				if (!client) {
					return;
				}
				const config = vscode.workspace.getConfiguration('proxmox');
				const template = config.get<string>('snapshotTemplate', 'snapshot-YYYYMMDD-HHMM');
				const snapshotName = generateSnapshotName(template);
				await client.createSnapshot(vm.node, vm.type, vm.id, snapshotName);
				markConnected();
				explorerProvider.refresh();
				vscode.window.showInformationMessage(`Created snapshot ${snapshotName}.`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				markDisconnected(message);
				vscode.window.showErrorMessage(`Failed to create snapshot: ${message}`);
			}
		}
	);

	const treeRestoreSnapshotDisposable = vscode.commands.registerCommand(
		'proxmox-vs-code.treeRestoreSnapshot',
		async (item?: ProxmoxExplorerItem) => {
			const vm = getVmFromExplorerItem(item);
			const snapshotName = item?.data?.snapshotName;
			if (!vm || !snapshotName) {
				vscode.window.showErrorMessage('No snapshot selected.');
				return;
			}

			const confirmRestore = await vscode.window.showWarningMessage(
				`Restore snapshot ${snapshotName}?`,
				{ modal: true },
				'Restore'
			);

			if (confirmRestore !== 'Restore') {
				return;
			}

			try {
				const client = await createClient(true);
				if (!client) {
					return;
				}
				await client.restoreSnapshot(vm.node, vm.type, vm.id, snapshotName);
				markConnected();
				explorerProvider.refresh();
				vscode.window.showInformationMessage(`Restored snapshot ${snapshotName}.`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				markDisconnected(message);
				vscode.window.showErrorMessage(`Failed to restore snapshot: ${message}`);
			}
		}
	);

	const resetWarningDisposable = vscode.commands.registerCommand(
		'proxmox-vs-code.resetInsecureWarning',
		async () => {
			await context.globalState.update('proxmox.suppressInsecureWarning', false);
			vscode.window.showInformationMessage('Proxmox insecure TLS warning has been reset.');
		}
	);

	const refreshIntervalMs = 5 * 60 * 1000;
	const refreshHandle = setInterval(() => {
		void refreshNodes(false);
	}, refreshIntervalMs);

	context.subscriptions.push(
		disposable,
		listNodesDisposable,
		listVmsDisposable,
		vmActionDisposable,
		snapshotActionDisposable,
		createSnapshotDisposable,
		restoreSnapshotDisposable,
		refreshExplorerDisposable,
		setApiTokenDisposable,
		clearApiTokenDisposable,
		testConnectionDisposable,
		treeStartDisposable,
		treeStopDisposable,
		treeRestartDisposable,
		treeCreateSnapshotDisposable,
		treeRestoreSnapshotDisposable,
		resetWarningDisposable,
		statusItem,
		explorerView,
		new vscode.Disposable(() => clearInterval(refreshHandle))
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
