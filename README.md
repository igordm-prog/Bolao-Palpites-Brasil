# Bolao Brasil Placares

MVP local para um site de bolao de placares do Campeonato Brasileiro, com cadastro por CPF, login, pagamentos manuais via PIX, palpites, pontuacao automatica, ranking e painel administrativo.

## Rodar localmente

```bash
npm install
npm run dev
```

## Banco de dados

Por padrao, o projeto ainda consegue usar `data/db.json` quando `DATABASE_URL` nao estiver definido. Para producao, use SQLite:

```env
DATABASE_URL=sqlite:data/bolao.sqlite
```

Para migrar os dados atuais do JSON para SQLite:

```bash
npm run migrate:sqlite
```

O script le `data/db.json` e grava no arquivo definido em `DATABASE_URL`. Antes de rodar em producao, faca backup do JSON:

```bash
cp data/db.json /root/db-backup-$(date +%F-%H%M).json
```

Arquivos `.sqlite`, `.db`, logs e `.env` nao devem ser enviados ao GitHub.

Acesse `http://localhost:3000`.

Administrador inicial:

- E-mail: `admin@bolaobrasilplacares.com.br`
- Senha: `Admin@123`

Altere a senha e o `SESSION_SECRET` antes de publicar.

## Nome sugerido

Nome comercial: **Bolao Brasil Placares**

Dominio sugerido: `bolaobrasilplacares.com.br`

Confirme a disponibilidade no Registro.br antes do registro definitivo.

## Escopo do MVP

- Cadastro com CPF, maioridade e aceite de termos.
- Login por e-mail ou CPF.
- Recuperacao de senha por link local.
- Painel do participante.
- Carteira simples com saldo e saque minimo configurado em R$ 30,00.
- Deposito minimo exibido em R$ 20,00.
- Criacao de boloes pelo administrador.
- Cadastro manual de jogos apenas para sabado/domingo.
- Pagamento manual via PIX copia e cola.
- Liberacao de palpites somente apos pagamento confirmado.
- Bloqueio de edicao apos o prazo do bolao.
- Lancamento de resultados.
- Calculo automatico de pontos.
- Ranking com criterios de desempate.
- Logs basicos de auditoria.
- Termos, Politica de Privacidade e Regras do Bolao.

## Proximos passos para producao

- Trocar o armazenamento JSON por MySQL/PostgreSQL.
- Configurar HTTPS, backup e monitoramento.
- Integrar gateway PIX com webhook.
- Integrar e-mail real para recuperacao de senha.
- Fazer revisao juridica antes de operar publicamente.
