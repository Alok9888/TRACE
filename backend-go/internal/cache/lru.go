package cache

import (
	"container/list"
	"sync"
	"time"
)

type entry[K comparable, V any] struct {
	key       K
	value     V
	expiresAt time.Time
}

// LRU is a bounded, thread-safe, TTL-expiring LRU cache.
// Used for embedding caches, verified chat session contexts, and Q&A response caching.
type LRU[K comparable, V any] struct {
	mu       sync.Mutex
	maxItems int
	ttl      time.Duration
	ll       *list.List
	items    map[K]*list.Element
}

func NewLRU[K comparable, V any](maxItems int, ttl time.Duration) *LRU[K, V] {
	if maxItems <= 0 {
		maxItems = 100
	}
	return &LRU[K, V]{
		maxItems: maxItems,
		ttl:      ttl,
		ll:       list.New(),
		items:    make(map[K]*list.Element, min(maxItems, 256)),
	}
}

func (c *LRU[K, V]) Get(key K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	var zero V
	el, ok := c.items[key]
	if !ok {
		return zero, false
	}
	ent := el.Value.(*entry[K, V])
	if c.ttl > 0 && time.Now().After(ent.expiresAt) {
		c.ll.Remove(el)
		delete(c.items, key)
		return zero, false
	}
	c.ll.MoveToFront(el)
	return ent.value, true
}

func (c *LRU[K, V]) Put(key K, val V) {
	c.mu.Lock()
	defer c.mu.Unlock()

	exp := time.Now().Add(c.ttl)
	if el, ok := c.items[key]; ok {
		ent := el.Value.(*entry[K, V])
		ent.value = val
		ent.expiresAt = exp
		c.ll.MoveToFront(el)
		return
	}
	el := c.ll.PushFront(&entry[K, V]{key: key, value: val, expiresAt: exp})
	c.items[key] = el
	for c.ll.Len() > c.maxItems {
		oldest := c.ll.Back()
		if oldest == nil {
			break
		}
		ent := oldest.Value.(*entry[K, V])
		delete(c.items, ent.key)
		c.ll.Remove(oldest)
	}
}

func (c *LRU[K, V]) DeleteIf(predicate func(K, V) bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	for el := c.ll.Front(); el != nil; {
		next := el.Next()
		ent := el.Value.(*entry[K, V])
		if predicate(ent.key, ent.value) {
			delete(c.items, ent.key)
			c.ll.Remove(el)
		}
		el = next
	}
}
