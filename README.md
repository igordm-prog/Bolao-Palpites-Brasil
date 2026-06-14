# Bolao Palpites Brasil

MVP local para o Bolao Palpites Brasil, com cadastro por CPF, login, carteira com PIX automatizado via Asaas, palpites, pontuacao automatica, ranking e painel administrativo.

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

## PIX automatico com Asaas

Configure no `.env`:

```env
ASAAS_ENV=production
ASAAS_API_KEY=sua-chave-do-asaas
ASAAS_WEBHOOK_TOKEN=um-token-secreto-grande
```

No painel do Asaas, cadastre o webhook de cobrancas apontando para:

```text
https://bolaopalpitesbrasil.com.br/webhooks/asaas
```

Use o mesmo valor de `ASAAS_WEBHOOK_TOKEN` como token de autenticacao do webhook. Quando o Asaas enviar `PAYMENT_RECEIVED` ou `PAYMENT_CONFIRMED`, o sistema marca o deposito como pago e credita a carteira automaticamente.

## Recuperacao de senha por e-mail

Configure um e-mail do dominio e preencha o SMTP no `.env`:

```env
APP_URL=https://bolaopalpitesbrasil.com.br
SMTP_HOST=smtp.seu-provedor.com.br
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=nao-responda@bolaopalpitesbrasil.com.br
SMTP_PASS=sua-senha-do-email
SMTP_FROM="Bolao Palpites Brasil <nao-responda@bolaopalpitesbrasil.com.br>"
```

Com SMTP configurado, o codigo de recuperacao e enviado para o e-mail cadastrado. Sem SMTP, o sistema mostra um codigo de teste na tela apenas para validacao local.

Acesse `http://localhost:3000`.

Administrador inicial:

- E-mail: `admin@bolaopalpitesbrasil.com.br`
- Senha: `Admin@123`

Altere a senha e o `SESSION_SECRET` antes de publicar.

## Nome sugerido

Nome comercial: **Bolao Palpites Brasil**

Dominio sugerido: `bolaopalpitesbrasil.com.br`

Confirme a disponibilidade no Registro.br antes do registro definitivo.

## Escopo do MVP

- Cadastro com CPF, maioridade e aceite de termos.
- Login por e-mail ou CPF.
- Recuperacao de senha por codigo enviado ao e-mail cadastrado.
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
- Configurar SMTP definitivo para recuperacao de senha.
- Fazer revisao juridica antes de operar publicamente.
