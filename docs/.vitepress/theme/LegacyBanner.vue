<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'

// Every page under docs/v3/ is the frozen v3.2.0 documentation.
const { page } = useData()
const legacy = computed(() => page.value.relativePath.startsWith('v3/'))
</script>

<template>
  <div v-if="legacy" class="vp-doc legacy-banner">
    <div class="custom-block warning" role="note">
      <p class="custom-block-title">Old version</p>
      <p>
        This is the documentation for v3.2.0. The current major version is v4. v4 removes the Paperclip integration and
        adds an optional hosted wiki. Read the <a :href="withBase('/upgrade')">upgrade guide</a>, or go to the
        <a :href="withBase('/')">current documentation</a>.
      </p>
    </div>
  </div>
</template>

<style scoped>
.legacy-banner {
  margin-bottom: 24px;
}
</style>
