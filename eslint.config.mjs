import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
export default tseslint.config({ignores:['**/.next/**','node_modules/**','coverage/**']},
 ...tseslint.configs.recommended,
 {files:['**/*.{ts,tsx}'],plugins:{'react-hooks':reactHooks},rules:{
   'react-hooks/rules-of-hooks':'error','react-hooks/exhaustive-deps':'warn',
   '@typescript-eslint/no-unused-vars':['warn',{argsIgnorePattern:'^_'}]
 }});
