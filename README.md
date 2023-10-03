# wyw-in-js: A Toolkit for Zero-Runtime CSS-in-JS Libraries

## Introduction

wyw-in-js, short for "Whatever-you-want-in-JS," is the world's first toolkit for creating various zero-runtime CSS(and more)-in-JS libraries. In essence, it empowers developers to build their own solutions with arbitrary syntax and functionality, offering complete independence from specific implementations.

## Origins

This library evolved from the CSS-in-JS library Linaria, with the aim of decoupling from a specific implementation and providing developers with a comprehensive toolkit for crafting their own solutions with custom syntax and features.

## Key Features

- Provides an API for creating custom processors (e.g., `css` and `styled` in Linaria or `makeStyles` in Griffel).
- Supports a wide range of syntaxes, including tagged templates, function calls, and object literals.
- Computes any unprepared JavaScript during the build phase, generating a set of artifacts that processors can transform into styles (or other outputs, depending on the processor).
- Allows for arbitrary JavaScript in style definitions, including imports, conditionals, and loops.
- Offers loaders and plugins for popular bundlers, ensuring compatibility with various build systems.
