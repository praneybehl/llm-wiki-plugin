import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import './custom.css'

function syncCurrentSidebarLink() {
  const active = document.querySelector<HTMLAnchorElement>(
    '.VPSidebarItem.is-active > .item > a',
  )

  document.querySelectorAll<HTMLAnchorElement>('.VPSidebar a[aria-current]').forEach((link) => {
    if (link !== active) link.removeAttribute('aria-current')
  })
  active?.setAttribute('aria-current', 'page')
}

function installAccessibilityEnhancements() {
  let searchTrigger: HTMLElement | null = null

  document.addEventListener(
    'pointerdown',
    (event) => {
      const trigger = (event.target as Element | null)?.closest<HTMLElement>('.DocSearch-Button')
      if (trigger) searchTrigger = trigger
    },
    true,
  )

  document.addEventListener(
    'keydown',
    (event) => {
      const activeElement = document.activeElement as HTMLElement | null
      if ((event.key === 'Enter' || event.key === ' ') && activeElement?.matches('.DocSearch-Button')) {
        searchTrigger = activeElement
      }

      if (event.key !== 'Escape' || !document.querySelector('.VPLocalSearchBox')) return
      const trigger = searchTrigger ?? document.querySelector<HTMLElement>('.DocSearch-Button')
      let attempts = 0
      const restoreFocus = () => {
        if (!document.querySelector('.VPLocalSearchBox')) {
          trigger?.focus()
        } else if (attempts++ < 4) {
          requestAnimationFrame(restoreFocus)
        }
      }
      requestAnimationFrame(restoreFocus)
    },
    true,
  )

  const observer = new MutationObserver(syncCurrentSidebarLink)
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  })
  requestAnimationFrame(syncCurrentSidebarLink)
}

export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (typeof document !== 'undefined') installAccessibilityEnhancements()
  },
} satisfies Theme
