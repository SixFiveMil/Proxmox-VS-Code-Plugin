import type { IncomingMessage, RequestOptions as HttpRequestOptions } from 'node:http';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';

export interface ProxmoxNode {
	name: string;
	status: 'online' | 'offline' | 'unknown';
}

export interface ProxmoxVm {
	id: number;
	name: string;
	status: 'running' | 'stopped' | 'unknown';
	type: 'qemu' | 'lxc';
	node: string;
}

export interface ProxmoxVmDetails {
	id: number;
	name: string;
	status: string;
	uptime: number;
	cpu: number;
	mem: number;
	maxMem: number;
	node: string;
	type: ProxmoxVm['type'];
}

export interface ProxmoxSnapshot {
	name: string;
	createdAt: number | null;
}

export interface ProxmoxClientConfig {
	host: string;
	apiToken: string;
	allowInsecure?: boolean;
}

export class ProxmoxClient {
	private readonly host: string;
	private readonly apiToken: string;
	private readonly allowInsecure: boolean;

	constructor(config: ProxmoxClientConfig) {
		this.host = config.host.trim();
		this.apiToken = config.apiToken.trim();
		this.allowInsecure = Boolean(config.allowInsecure);
	}

	async listNodes(): Promise<ProxmoxNode[]> {
		if (!this.host || !this.apiToken) {
			throw new Error('Proxmox host or API token is not configured.');
		}

		const baseUrl = new URL(this.host.endsWith('/') ? this.host : `${this.host}/`);
		const response = await this.requestJson<{ data: Array<{ node?: string; status?: string }> }>(
			new URL('api2/json/nodes', baseUrl)
		);

		const nodes = response.data ?? [];
		return nodes.map((node) => ({
			name: node.node ?? 'unknown',
			status: this.normalizeStatus(node.status)
		}));
	}

	async listVirtualMachines(node: string): Promise<ProxmoxVm[]> {
		if (!this.host || !this.apiToken) {
			throw new Error('Proxmox host or API token is not configured.');
		}

		const baseUrl = new URL(this.host.endsWith('/') ? this.host : `${this.host}/`);
		const nodePath = `api2/json/nodes/${encodeURIComponent(node)}`;
		const [qemuResponse, lxcResponse] = await Promise.all([
			this.requestJson<{ data: Array<{ vmid?: number; name?: string; status?: string }> }>(
				new URL(`${nodePath}/qemu`, baseUrl)
			),
			this.requestJson<{ data: Array<{ vmid?: number; name?: string; status?: string }> }>(
				new URL(`${nodePath}/lxc`, baseUrl)
			)
		]);

		const qemuVms = (qemuResponse.data ?? []).map((vm) => this.mapVm(vm, 'qemu', node));
		const lxcVms = (lxcResponse.data ?? []).map((vm) => this.mapVm(vm, 'lxc', node));
		return [...qemuVms, ...lxcVms].sort((a, b) => a.id - b.id);
	}

	async getVirtualMachineDetails(node: string, type: ProxmoxVm['type'], vmId: number): Promise<ProxmoxVmDetails> {
		if (!this.host || !this.apiToken) {
			throw new Error('Proxmox host or API token is not configured.');
		}

		const response = await this.requestJson<{
			data: { name?: string; status?: string; uptime?: number; cpu?: number; mem?: number; maxmem?: number };
		}>(new URL(`api2/json/nodes/${encodeURIComponent(node)}/${type}/${vmId}/status/current`, this.normalizedBaseUrl()));

		const data = response.data ?? {};
		return {
			id: vmId,
			name: data.name?.trim() || `VM ${vmId}`,
			status: data.status ?? 'unknown',
			uptime: data.uptime ?? 0,
			cpu: data.cpu ?? 0,
			mem: data.mem ?? 0,
			maxMem: data.maxmem ?? 0,
			node,
			type
		};
	}

	async startVirtualMachine(node: string, type: ProxmoxVm['type'], vmId: number): Promise<void> {
		await this.requestJson(
			new URL(
				`api2/json/nodes/${encodeURIComponent(node)}/${type}/${vmId}/status/start`,
				this.normalizedBaseUrl()
			),
			'POST'
		);
	}

	async stopVirtualMachine(node: string, type: ProxmoxVm['type'], vmId: number): Promise<void> {
		await this.requestJson(
			new URL(
				`api2/json/nodes/${encodeURIComponent(node)}/${type}/${vmId}/status/stop`,
				this.normalizedBaseUrl()
			),
			'POST'
		);
	}

	async restartVirtualMachine(node: string, type: ProxmoxVm['type'], vmId: number): Promise<void> {
		await this.requestJson(
			new URL(
				`api2/json/nodes/${encodeURIComponent(node)}/${type}/${vmId}/status/reboot`,
				this.normalizedBaseUrl()
			),
			'POST'
		);
	}

	async listSnapshots(node: string, type: ProxmoxVm['type'], vmId: number): Promise<ProxmoxSnapshot[]> {
		const response = await this.requestJson<{ data: Array<{ name?: string; snaptime?: number }> }>(
			new URL(`api2/json/nodes/${encodeURIComponent(node)}/${type}/${vmId}/snapshot`, this.normalizedBaseUrl())
		);

		return (response.data ?? [])
			.filter((snapshot) => snapshot.name && snapshot.name !== 'current')
			.map((snapshot) => ({
				name: snapshot.name ?? 'unknown',
				createdAt: snapshot.snaptime ?? null
			}));
	}

	async createSnapshot(node: string, type: ProxmoxVm['type'], vmId: number, name: string): Promise<void> {
		await this.requestJson(
			new URL(`api2/json/nodes/${encodeURIComponent(node)}/${type}/${vmId}/snapshot`, this.normalizedBaseUrl()),
			'POST',
			{ snapname: name }
		);
	}

	async deleteSnapshot(node: string, type: ProxmoxVm['type'], vmId: number, name: string): Promise<void> {
		await this.requestJson(
			new URL(
				`api2/json/nodes/${encodeURIComponent(node)}/${type}/${vmId}/snapshot/${encodeURIComponent(name)}`,
				this.normalizedBaseUrl()
			),
			'DELETE'
		);
	}

	async restoreSnapshot(node: string, type: ProxmoxVm['type'], vmId: number, name: string): Promise<void> {
		await this.requestJson(
			new URL(
				`api2/json/nodes/${encodeURIComponent(node)}/${type}/${vmId}/snapshot/${encodeURIComponent(name)}/rollback`,
				this.normalizedBaseUrl()
			),
			'POST'
		);
	}

	private normalizeStatus(status?: string): ProxmoxNode['status'] {
		if (status === 'online' || status === 'offline') {
			return status;
		}

		return 'unknown';
	}

	private normalizeVmStatus(status?: string): ProxmoxVm['status'] {
		if (status === 'running' || status === 'stopped') {
			return status;
		}

		return 'unknown';
	}

	private mapVm(
		vm: { vmid?: number; name?: string; status?: string },
		type: ProxmoxVm['type'],
		node: string
	): ProxmoxVm {
		return {
			id: vm.vmid ?? -1,
			name: vm.name?.trim() || `VM ${vm.vmid ?? 'unknown'}`,
			status: this.normalizeVmStatus(vm.status),
			type,
			node
		};
	}

	private normalizedBaseUrl(): URL {
		return new URL(this.host.endsWith('/') ? this.host : `${this.host}/`);
	}

	private async requestJson<T>(
		url: URL,
		method: 'GET' | 'POST' | 'DELETE' = 'GET',
		body?: Record<string, string | number | boolean>
	): Promise<T> {
		const useHttps = url.protocol !== 'http:';
		const { request, Agent } = await import(useHttps ? 'node:https' : 'node:http');

		return new Promise<T>((resolve, reject) => {
			const payload = body
				? new URLSearchParams(
					Object.fromEntries(Object.entries(body).map(([key, value]) => [key, String(value)]))
				).toString()
				: undefined;
			const contentLength = payload ? Buffer.byteLength(payload) : 0;
			const requestOptions: HttpRequestOptions & HttpsRequestOptions & { agent?: unknown } = {
				method,
				headers: {
					Accept: 'application/json',
					Authorization: `PVEAPIToken=${this.apiToken}`,
					...(payload
						? {
							'Content-Type': 'application/x-www-form-urlencoded',
							'Content-Length': contentLength.toString()
						}
						: {})
				},
				agent: useHttps && this.allowInsecure ? new Agent({ rejectUnauthorized: false }) : undefined,
				rejectUnauthorized: useHttps ? !this.allowInsecure : undefined
			};

			const req = request(url, requestOptions, (res: IncomingMessage) => {
				const { statusCode } = res;
				let body = '';

				res.setEncoding('utf8');
				res.on('data', (chunk: string) => {
					body += chunk;
				});

				res.on('end', () => {
					if (!statusCode || statusCode < 200 || statusCode >= 300) {
						reject(new Error(`Proxmox API error ${statusCode ?? 'unknown'}: ${body}`));
						return;
					}

					try {
						resolve(JSON.parse(body) as T);
					} catch (error) {
						reject(error);
					}
				});
			});

			req.on('error', (error: Error) => reject(error));
			if (payload) {
				req.write(payload);
			}
			req.end();
		});
	}
}
