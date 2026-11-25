import type { ActivityGameplayModule } from '../types'

export { default as SweetPotatoTab } from '../../SweetPotatoTab.vue'

export const sweetPotatoGameplay: ActivityGameplayModule = {
  key: 'sweetPotato',
  defaultTab: 'sweetPotato',
  tabs: ['sweetPotato'],
}
