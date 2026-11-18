import { createApp } from 'vue';
import ArtGallery from './ArtGallery.vue';
import '../index.css';

// Dev-only: lets headless screenshots pin the map zoom via ?zoom=<n> before the canvas reads it.
const zoomParam = new URLSearchParams(window.location.search).get('zoom');
if (zoomParam !== null) {
  localStorage.setItem('peerspace_map_zoom', zoomParam);
} else {
  localStorage.setItem('peerspace_map_zoom', '1');
}

createApp(ArtGallery).mount('#root');
