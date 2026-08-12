const stage = document.querySelector('.hero-stage');
const replay = document.querySelector('.replay');
const states = ['select', 'write', 'send'];
let animationTimer;

function playDemo() {
  if (!stage) return;
  window.clearInterval(animationTimer);
  let index = 0;
  stage.dataset.demoState = states[index];
  animationTimer = window.setInterval(() => {
    index = (index + 1) % states.length;
    stage.dataset.demoState = states[index];
  }, 2800);
}

replay?.addEventListener('click', () => {
  stage.classList.remove('restarting');
  void stage.offsetWidth;
  stage.classList.add('restarting');
  playDemo();
});

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
if (!reducedMotion.matches) playDemo();

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.14 });

document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));

document.addEventListener('pointermove', (event) => {
  document.documentElement.style.setProperty('--light-x', `${event.clientX}px`);
  document.documentElement.style.setProperty('--light-y', `${event.clientY}px`);
}, { passive: true });

document.querySelector('[data-copy]')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.textContent = 'Copied';
    window.setTimeout(() => { button.textContent = 'Copy'; }, 1800);
  } catch {
    button.textContent = 'Select command';
  }
});
