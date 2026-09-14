/**
 * 带容量上限的 LRU 缓存。
 *
 * Map 的插入顺序即使用顺序：命中时先删后插把条目移到队尾，超限时从队首驱逐。
 * 用于给「按 sessionPath 缓存整份会话归档」这类大对象一个堆占用上界——这类缓存
 * 只增不减时，本次运行里碰过的每个会话都会把归档永久钉在堆上。
 *
 * 保底一条：单条就超过上限时保留最新一条，否则缓存会因注不进大条目而永远为空。
 */
export class BoundedLruCache<K, V> {
	private readonly entries = new Map<K, V>();
	private totalSize = 0;

	constructor(
		private readonly maxSize: number,
		private readonly sizeOf: (value: V) => number,
	) {}

	get(key: K): V | undefined {
		const value = this.entries.get(key);
		if (value === undefined) return undefined;
		// 命中即刷新到队尾，保证驱逐顺序是「最久未用」。
		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	set(key: K, value: V): void {
		const previous = this.entries.get(key);
		if (previous !== undefined) {
			this.totalSize -= this.sizeOf(previous);
			this.entries.delete(key);
		}
		this.entries.set(key, value);
		this.totalSize += this.sizeOf(value);
		while (this.totalSize > this.maxSize && this.entries.size > 1) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			const evicted = this.entries.get(oldest.value);
			this.entries.delete(oldest.value);
			if (evicted !== undefined) this.totalSize -= this.sizeOf(evicted);
		}
	}
}
