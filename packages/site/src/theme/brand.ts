// The organisation's logo and name at the right of the nav bar (#33). A Vue
// component in VitePress's nav slot, so hydration and in-site navigation keep
// one instance; it asks the hub once, after mount, and shows nothing until the
// hub has answered with a name, or at all if the request fails.
import { useData } from 'vitepress';
import { defineComponent, h, onMounted, ref } from 'vue';
import { apiFor, type Brand } from './review/api';

export const BRAND_CLASS = 'sr-brand';

export const OrgBrand = defineComponent({
  name: 'OrgBrand',
  setup() {
    const { site } = useData();
    const brand = ref<Brand | null>(null);
    // A logo that does not load gives way to the name.
    const broken = ref(false);
    const api = apiFor(site.value.base);
    onMounted(() => {
      api.brand().then(
        (b) => (brand.value = b),
        () => (brand.value = null),
      );
    });
    return () => {
      const b = brand.value;
      if (!b?.name) return null;
      const logo = b.logo && !broken.value;
      return h('span', { class: BRAND_CLASS }, [
        logo
          ? h('img', {
              class: `${BRAND_CLASS}-logo`,
              src: api.logoUrl(),
              alt: b.name,
              onError: () => (broken.value = true),
            })
          : null,
        h('span', { class: `${BRAND_CLASS}-name`, 'aria-hidden': logo ? 'true' : undefined }, b.name),
      ]);
    };
  },
});
