import { createElement } from '../createElement';
import { effect } from '../effect';
import {
  Commit,
  Delta,
  DeltaTypes,
  DOMNode,
  Driver,
  Effect,
  EffectTypes,
  Flags,
  NODE_OBJECT_POOL_FIELD,
  VElement,
  VNode,
} from '../types';

/**
 * Diffs two VNode children and modifies the DOM node based on the necessary changes
 */
export const useChildren =
  (drivers: any[] = []): any =>
  (
    el: HTMLElement | SVGElement,
    newVNode: VElement,
    oldVNode?: VElement,
    commit: Commit = (work: () => void) => work(),
    effects: Effect[] = [],
    driver?: Driver,
  ): ReturnType<Driver> => {
    const queueEffect = effect(el, effects);
    const getData = (element: DOMNode): ReturnType<Driver> => ({
      el: element,
      newVNode,
      oldVNode,
      effects,
      commit,
      driver,
    });

    const finish = (element: DOMNode): ReturnType<Driver> => {
      const data = getData(element);
      for (let i = 0; i < drivers.length; ++i) {
        commit(() => {
          (drivers[i] as Driver)(el, newVNode, oldVNode, commit, effects, driver);
        }, data);
      }
      return data;
    };

    const oldVNodeChildren: VNode[] = oldVNode?.children ?? [];
    const newVNodeChildren: VNode[] | undefined = newVNode.children;
    const delta: Delta[] | undefined = newVNode.delta;
    const diff = (el: DOMNode, newVNode: VNode, oldVNode?: VNode) =>
      driver!(el, newVNode, oldVNode, commit, effects).effects!;

    // Deltas are a way for the compile-time to optimize runtime operations
    // by providing a set of predefined operations. This is useful for cases
    // where you are performing consistent, predictable operations at a high
    // interval, low payload situation.
    if (delta) {
      for (let i = 0; i < delta.length; ++i) {
        const [deltaType, deltaPosition] = delta[i];
        const child = el.childNodes.item(deltaPosition) as DOMNode;

        if (deltaType === DeltaTypes.CREATE) {
          queueEffect(EffectTypes.CREATE, () =>
            el.insertBefore(createElement(newVNodeChildren![deltaPosition], false), child),
          );
        }

        if (deltaType === DeltaTypes.UPDATE) {
          commit(() => {
            effects = diff(
              child,
              newVNodeChildren![deltaPosition],
              oldVNodeChildren[deltaPosition],
            );
          }, getData(child));
        }

        if (deltaType === DeltaTypes.REMOVE) {
          queueEffect(EffectTypes.REMOVE, () => el.removeChild(child));
        }
      }
      return finish(el);
    }

    // Flags allow for greater optimizability by reducing condition branches.
    // Generally, you should use a compiler to generate these flags, but
    // hand-writing them is also possible
    if (!newVNodeChildren || newVNode.flag === Flags.ELEMENT_NO_CHILDREN) {
      if (!oldVNodeChildren) return finish(el);

      queueEffect(EffectTypes.REMOVE, () => (el.textContent = ''));
      return finish(el);
    }

    if (!oldVNodeChildren || oldVNodeChildren?.length === 0) {
      for (let i = 0; i < newVNodeChildren.length; ++i) {
        queueEffect(EffectTypes.CREATE, () =>
          el.appendChild(createElement(newVNodeChildren[i], false)),
        );
      }
      return finish(el);
    }

    /**
     * ∆drown - "diff or drown"
     *
     * Million's keyed children diffing is a variant of Hunt-Szymanski[1] algorithm. They
     * both are in O(ND) time to find shortest edit distance. However, instead of using a
     * longest increasing subsequence algorithm, it generates a key map and deals with
     * it linearly. Additionally, Million holds removed keyed nodes in an mapped object
     * pool, recycling DOM nodes to reduce unnecessary element creation computation.
     *
     * [1] Hunt-Szymanski algorithm:
     *  - https://neil.fraser.name/writing/diff
     *  - https://citeseerx.ist.psu.edu/viewdoc/download?doi=10.1.1.608.1614&rep=rep1&type=pdf
     *  - https://citeseerx.ist.psu.edu/viewdoc/download?doi=10.1.1.4.6927&rep=rep1&type=pdf
     *
     * This diffing algorithm attempts to reduce the number of DOM operations that
     * need to be performed by leveraging keys. It works in several steps:
     *
     * 1. Common end optimization
     *
     * This optimization technique is looking for nodes with identical keys by
     * simultaneously iterating through nodes in the old children list `oldVNodeChildren`
     * and new children list `newVNodeChildren` from both the suffix[2] and prefix[3].
     *
     *  oldVNodeChildren: -> [a b c d] <-
     *  newVNodeChildren: -> [a b d] <-
     *
     * Skip nodes "a" and "b" at the start, and node "d" at the end.
     *
     *  oldVNodeChildren: -> [c] <-
     *  newVNodeChildren: -> [] <-
     *
     * 2. Right/left move optimization
     *
     * This optimization technique allows for nodes to be shifted right[4] or left[5] without
     * the generation of a key map. This technique works for both R->L and L->R traversals,
     * and can significantly reduce the number of DOM operations necesssary without the LIS
     * technique.
     *
     *  oldVNodeChildren: [a b c X]
     *                           ^
     *  newVNodeChildren: [X a b c]
     *                     ^
     *
     * 3. Zero length optimization
     *
     * Check if the size of one of the list is equal to zero. When length of the old
     * children list `oldVNodeChildren` is zero, insert remaining nodes from the new
     * list `newVNodeChildren`[6]. When length of `newVNodeChildren` is zero, remove
     * remaining nodes from `oldVNodeChildren`[7].
     *
     *  oldVNodeChildren: -> [a b c d] <-
     *  newVNodeChildren: -> [a d] <-
     *
     * Skip nodes "a" and "d" (prefix and suffix optimization).
     *
     *  oldVNodeChildren: [b c]
     *  newVNodeChildren: []
     *
     * Remove nodes "b" and "c".
     *
     * 4. Index and reorder continuous DOM nodes optimization
     *
     * Assign original positions of the nodes from the old children list `oldVNodeChildren`
     * to key map `oldKeyMap`[8].
     *
     *  oldVNodeChildren: [b c d e f]
     *  newVNodeChildren: [c b h f e]
     *  oldKeyMap: {
     *    b: 0, // newVNodeChildren[0] == b
     *    c: 1, // newVNodeChildren[1] == c
     *    d: 2,
     *    e: 3,
     *    f: 4,
     *  }
     *
     * Iterate through `newVNodeChildren` (bounded by common end optimizations) and
     * check if the new child key is in the `oldKeyMap`. If it is, then fetch the old
     * node and insert the node at the new index[9].
     *
     * "c" is in the `oldKeyMap`, so fetch the old node at index `oldKeyMap[c] == 1`
     * and insert it in the DOM at index 0, or the new child index.
     *
     *  oldVNodeChildren: [b c d e f]
     *  newVNodeChildren: [c b h f e]
     *                     ^
     *  oldKeyMap: {
     *    b: 0,
     *    c: 1, // <- delete
     *    d: 2,
     *    e: 3,
     *    f: 4,
     *  }
     *
     * "b" is in the oldKeyMap, so fetch the old node at index `oldKeyMap[b] == 0`
     * and insert it in the DOM at index 1, or the new child index.
     *
     *  oldVNodeChildren: [b c d e f]
     *  newVNodeChildren: [c b h f e]
     *                       ^
     *  oldKeyMap: {
     *    b: 0, // <- delete
     *    d: 2,
     *    e: 3,
     *    f: 4,
     *  }
     *
     * "h" is not in the oldKeyMap, create a new node and insert it in the
     * DOM at index 2, or the new child index [10].
     *
     *  oldVNodeChildren: [b c d e f]
     *  newVNodeChildren: [c b h f e]
     *                         ^
     *  oldKeyMap: {
     *    d: 2,
     *    e: 3,
     *    f: 4,
     *  }
     *
     * "f" is in the oldKeyMap, so fetch the old node at index `oldKeyMap[f] == 4`
     * and insert it in the DOM at index 3, or the new child index.
     *
     *  oldVNodeChildren: [b c d e f]
     *  newVNodeChildren: [c b h f e]
     *                           ^
     *  oldKeyMap: {
     *    d: 2,
     *    e: 3,
     *    f: 4, // <- delete
     *  }
     *
     * "e" is in the oldKeyMap, so fetch the old node at index `oldKeyMap[e] == 3`
     * and insert it in the DOM at index 4, or the new child index.
     *
     *  oldVNodeChildren: [b c d e f]
     *  newVNodeChildren: [c b h f e]
     *                             ^
     *  oldKeyMap: {
     *    d: 2,
     *    e: 3, // <- delete
     *  }
     *
     * 5. Index and delete removed nodes.
     *
     * Iterate through `oldKeyMap` values and remove DOM nodes at those indicies[11].
     *
     * "d" is remaining in `oldKeyMap`, so remove old DOM node at index.
     *
     *  oldVNodeChildren: [b c d e f]
     *                         ^
     *  newVNodeChildren: [c b h f e]
     *  oldKeyMap: {
     *    d: 2, // <- check
     *  }
     */
    if (newVNode.flag === Flags.ELEMENT_KEYED_CHILDREN) {
      if (!el[NODE_OBJECT_POOL_FIELD]) el[NODE_OBJECT_POOL_FIELD] = new Map<string, DOMNode>();

      let oldHead = 0;
      let newHead = 0;
      let oldTail = oldVNodeChildren.length - 1;
      let newTail = newVNodeChildren.length - 1;

      while (oldHead <= oldTail && newHead <= newTail) {
        const oldTailVNode = oldVNodeChildren[oldTail] as VElement;
        const newTailVNode = newVNodeChildren[newTail] as VElement;
        const oldHeadVNode = oldVNodeChildren[oldHead] as VElement;
        const newHeadVNode = newVNodeChildren[newHead] as VElement;

        if (oldTailVNode.key === newTailVNode.key) {
          // [2] Suffix optimization
          oldTail--;
          newTail--;
        } else if (oldHeadVNode.key === newHeadVNode.key) {
          // [3] Prefix optimization
          oldHead++;
          newHead++;
        } else if (oldHeadVNode.key === newTailVNode.key) {
          // [4] Right move
          const node = el.childNodes.item(oldHead++);
          const tail = newTail--;
          queueEffect(EffectTypes.CREATE, () =>
            el.insertBefore(node, el.childNodes.item(tail).nextSibling),
          );
        } else if (oldTailVNode.key === newHeadVNode.key) {
          // [5] Left move
          const node = el.childNodes.item(oldTail--);
          const head = newHead++;
          queueEffect(EffectTypes.CREATE, () => el.insertBefore(node, el.childNodes.item(head)));
        } else break;
      }

      if (oldHead > oldTail) {
        // [6] Old children optimization
        while (newHead <= newTail) {
          const head = newHead++;
          const cachedNode = el[NODE_OBJECT_POOL_FIELD].get(
            (newVNodeChildren[head] as VElement).key,
          );
          queueEffect(EffectTypes.CREATE, () =>
            el.insertBefore(
              cachedNode ?? createElement(newVNodeChildren[head], false),
              el.childNodes.item(head),
            ),
          );
        }
      } else if (newHead > newTail) {
        // [7] New children optimization
        while (oldHead <= oldTail) {
          const head = oldHead++;
          const node = el.childNodes.item(head);
          el[NODE_OBJECT_POOL_FIELD].set((oldVNodeChildren[head] as VElement).key!, node);
          queueEffect(EffectTypes.REMOVE, () => el.removeChild(node));
        }
      } else {
        // [8] Indexing old children
        const oldKeyMap = new Map<string, number>();

        for (; oldHead <= oldTail; ) {
          oldKeyMap.set((oldVNodeChildren[oldHead] as VElement).key!, oldHead++);
        }

        while (newHead <= newTail) {
          const head = newHead++;
          const newVNodeChild = newVNodeChildren[head] as VElement;
          const oldIndex = oldKeyMap.get(newVNodeChild.key!);

          if (oldIndex !== undefined) {
            // [9] Reordering continuous nodes
            const node = el.childNodes.item(oldIndex);
            queueEffect(EffectTypes.CREATE, () => el.insertBefore(node, el.childNodes.item(head)));
            oldKeyMap.delete(newVNodeChild.key!);
          } else {
            // [10] Create new nodes
            const cachedNode = el[NODE_OBJECT_POOL_FIELD].get(newVNodeChild.key);
            queueEffect(EffectTypes.CREATE, () =>
              el.insertBefore(
                cachedNode ?? createElement(newVNodeChild, false),
                el.childNodes.item(head),
              ),
            );
          }
        }

        // [11] Clean up removed nodes
        for (const [oldVNodeKey, oldVNodeValue] of oldKeyMap) {
          const node = el.childNodes.item(oldVNodeValue);
          el[NODE_OBJECT_POOL_FIELD].set(oldVNodeKey, node);
          queueEffect(EffectTypes.REMOVE, () => el.removeChild(node));
        }
      }

      return finish(el);
    }

    if (newVNode.flag === Flags.ELEMENT_TEXT_CHILDREN) {
      const oldString = Array.isArray(oldVNode?.children)
        ? oldVNode?.children.join('')
        : oldVNode?.children;
      const newString = Array.isArray(newVNode?.children)
        ? newVNode?.children.join('')
        : newVNode?.children;
      if (oldString !== newString) {
        queueEffect(EffectTypes.REPLACE, () => (el.textContent = newString!));
      }
      return finish(el);
    }

    if (oldVNodeChildren && newVNodeChildren) {
      const commonLength = Math.min(oldVNodeChildren.length, newVNodeChildren.length);

      // Interates backwards, so in case a childNode is destroyed, it will not shift the nodes
      // and break accessing by index
      for (let i = commonLength - 1; i >= 0; --i) {
        commit(() => {
          effects = diff(
            el.childNodes.item(i) as DOMNode,
            newVNodeChildren[i],
            oldVNodeChildren[i],
          );
        }, getData(el));
      }

      if (newVNodeChildren.length > oldVNodeChildren.length) {
        for (let i = commonLength; i < newVNodeChildren.length; ++i) {
          const node = createElement(newVNodeChildren[i], false);
          queueEffect(EffectTypes.CREATE, () => el.appendChild(node));
        }
      } else if (newVNodeChildren.length < oldVNodeChildren.length) {
        for (let i = oldVNodeChildren.length - 1; i >= commonLength; --i) {
          queueEffect(EffectTypes.REMOVE, () => el.removeChild(el.childNodes.item(i)));
        }
      }
    } else if (newVNodeChildren) {
      for (let i = 0; i < newVNodeChildren.length; ++i) {
        const node = createElement(newVNodeChildren[i], false);
        queueEffect(EffectTypes.CREATE, () => el.appendChild(node));
      }
    }

    return finish(el);
  };
