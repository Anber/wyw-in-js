import {css, cx} from "@linaria/core";
import {styled} from "@linaria/react";

const fontSize = 16;

export const base = css`
    color: green;
`;

export const Button = styled.button`
    .${base} {
        font-size: ${fontSize}px;
    }
`;


export const DangerButton = styled(Button)`
    color: red;
`;

const combined = cx(base, css` color: blue; `);
