import Image from 'next/image';
import { css } from '@linaria/core';

const styles = {
  main: css`
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    padding: 6rem;
    min-height: 100vh;
  `,
  description: css`
    display: inherit;
    justify-content: inherit;
    align-items: inherit;
    font-size: 0.85rem;
    max-width: var(--max-width);
    width: 100%;
    z-index: 2;
    font-family: var(--font-mono);

    & a {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 0.5rem;
    }

    & p {
      position: relative;
      margin: 0;
      padding: 1rem;
      background-color: rgba(var(--callout-rgb), 0.5);
      border: 1px solid rgba(var(--callout-border-rgb), 0.3);
      border-radius: var(--border-radius);
    }

    @media (max-width: 700px) {
      font-size: 0.8rem;

      & a {
        padding: 1rem;
      }
      & p,
      & div {
        display: flex;
        justify-content: center;
        position: fixed;
        width: 100%;
      }
      & p {
        align-items: center;
        inset: 0 0 auto;
        padding: 2rem 1rem 1.4rem;
        border-radius: 0;
        border: none;
        border-bottom: 1px solid rgba(var(--callout-border-rgb), 0.25);
        background: linear-gradient(
          to bottom,
          rgba(var(--background-start-rgb), 1),
          rgba(var(--callout-rgb), 0.5)
        );
        background-clip: padding-box;
        backdrop-filter: blur(24px);
      }
      & div {
        align-items: flex-end;
        pointer-events: none;
        inset: auto 0 0;
        padding: 2rem;
        height: 200px;
        background: linear-gradient(
          to bottom,
          transparent 0%,
          rgb(var(--background-end-rgb)) 40%
        );
        z-index: 1;
      }
    }
  `,
  code: css`
    font-weight: 700;
    font-family: var(--font-mono);
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(4, minmax(25%, auto));
    max-width: 100%;
    width: var(--max-width);

    @media (max-width: 700px) {
      grid-template-columns: 1fr;
      margin-bottom: 120px;
      max-width: 320px;
      text-align: center;
    }

    @media (min-width: 701px) and (max-width: 1120px) {
      grid-template-columns: repeat(2, 50%);
    }
  `,
  card: css`
    padding: 1rem 1.2rem;
    border-radius: var(--border-radius);
    background: rgba(var(--card-rgb), 0);
    border: 1px solid rgba(var(--card-border-rgb), 0);
    transition:
      background 200ms,
      border 200ms;

    & span {
      display: inline-block;
      transition: transform 200ms;
    }

    & h2 {
      font-weight: 600;
      margin-bottom: 0.7rem;
    }

    & p {
      margin: 0;
      opacity: 0.6;
      font-size: 0.9rem;
      line-height: 1.5;
      max-width: 30ch;
      text-wrap: balance;
    }

    @media (max-width: 700px) {
      padding: 1rem 2.5rem;

      & h2 {
        margin-bottom: 0.5rem;
      }
    }

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background: rgba(var(--card-rgb), 0.1);
        border: 1px solid rgba(var(--card-border-rgb), 0.15);
      }
      &:hover span {
        transform: translateX(4px);
      }
    }
    @media (prefers-reduced-motion) {
      &:hover span {
        transform: none;
      }
    }
  `,
  center: css`
    display: flex;
    justify-content: center;
    align-items: center;
    position: relative;
    padding: 4rem 0;

    &::before {
      background: var(--secondary-glow);
      border-radius: 50%;
      width: 480px;
      height: 360px;
      margin-left: -400px;
    }

    &::after {
      background: var(--primary-glow);
      width: 240px;
      height: 180px;
      z-index: -1;
    }

    &::before,
    &::after {
      content: '';
      left: 50%;
      position: absolute;
      filter: blur(45px);
      transform: translateZ(0);
    }

    @media (max-width: 700px) {
      padding: 8rem 0 6rem;

      &::before {
        transform: none;
        height: 300px;
      }
    }
  `,
  logo: css`
    position: relative;

    @media (prefers-color-scheme: dark) {
      filter: invert(1) drop-shadow(0 0 0.3rem #ffffff70);
    }
  `,
  vercelLogo: css`
    filter: invert(1);
  `,
};

export default function Home() {
  return (
    <main className={styles.main}>
      <div className={styles.description}>
        <p>
          Get started by editing&nbsp;
          <code className={styles.code}>src/app/page.tsx</code>
        </p>
        <div>
          <a
            href="https://vercel.com?utm_source=create-next-app&utm_medium=appdir-template&utm_campaign=create-next-app"
            target="_blank"
            rel="noopener noreferrer"
          >
            By{' '}
            <Image
              src="/vercel.svg"
              alt="Vercel Logo"
              className={styles.vercelLogo}
              width={100}
              height={24}
              priority
            />
          </a>
        </div>
      </div>

      <div className={styles.center}>
        <Image
          className={styles.logo}
          src="/next.svg"
          alt="Next.js Logo"
          width={180}
          height={37}
          priority
        />
      </div>

      <div className={styles.grid}>
        <a
          href="https://nextjs.org/docs?utm_source=create-next-app&utm_medium=appdir-template&utm_campaign=create-next-app"
          className={styles.card}
          target="_blank"
          rel="noopener noreferrer"
        >
          <h2>
            Docs <span>-&gt;</span>
          </h2>
          <p>Find in-depth information about Next.js features and API.</p>
        </a>

        <a
          href="https://nextjs.org/learn?utm_source=create-next-app&utm_medium=appdir-template&utm_campaign=create-next-app"
          className={styles.card}
          target="_blank"
          rel="noopener noreferrer"
        >
          <h2>
            Learn <span>-&gt;</span>
          </h2>
          <p>Learn about Next.js in an interactive course with&nbsp;quizzes!</p>
        </a>

        <a
          href="https://vercel.com/templates?framework=next.js&utm_source=create-next-app&utm_medium=appdir-template&utm_campaign=create-next-app"
          className={styles.card}
          target="_blank"
          rel="noopener noreferrer"
        >
          <h2>
            Templates <span>-&gt;</span>
          </h2>
          <p>Explore starter templates for Next.js.</p>
        </a>

        <a
          href="https://vercel.com/new?utm_source=create-next-app&utm_medium=appdir-template&utm_campaign=create-next-app"
          className={styles.card}
          target="_blank"
          rel="noopener noreferrer"
        >
          <h2>
            Deploy <span>-&gt;</span>
          </h2>
          <p>
            Instantly deploy your Next.js site to a shareable URL with Vercel.
          </p>
        </a>
      </div>
    </main>
  );
}
