# Mestre

Extensão independente para o **Agent Mode do TauriTavern 2.4.0**. O Agent pode manter a continuidade de uma história, administrar Lorebooks do World Info e preparar a próxima cena usando a conversa aberta.

## Instalação

1. Extraia **mestre-agent-0.1.0.zip** na pasta **default-user/extensions** da pasta de dados do TauriTavern. No desktop, o local aparece em **System → Data Directory**. Confirme que ficou **extensions/mestre-agent/manifest.json**.
2. Recarregue o TauriTavern e verifique **Mestre — World Info e caderno** no gerenciador de extensões. Abra um chat salvo e clique em **Mestre** junto à caixa de mensagem.
3. Em **Agent System**, abra o perfil usado pelo chat e selecione as seis ferramentas **mestre_…** na lista de ferramentas. Salve o perfil e ative **Agent Mode**. O modelo do perfil precisa aceitar chamadas de ferramentas.

O pacote contém os arquivos JavaScript e CSS prontos para carregar. [Carregamento de extensões](https://github.com/Darkatse/TauriTavern/blob/v2.4.0/docs/CurrentState/ThirdPartyExtensions.md) · [Ferramentas do Agent](https://github.com/Darkatse/TauriTavern/blob/v2.4.0/docs/API/Agent.md)

## World Info

- O Agent pode criar um Lorebook nativo e adicionar entradas enquanto joga. O livro novo pode entrar automaticamente no contexto da conversa pelo Mestre.
- O livro nativo já vinculado ao chat fica disponível para leitura e edição pelas ferramentas do Mestre. Para ajustar o acesso desse livro ou liberar outro, abra **Mestre → Lorebooks → Abrir**, escolha o acesso e clique em **Salvar acesso**.
- Uma alteração pode ajustar título, texto, chaves, ativação, posição, ordem, profundidade, probabilidade ou efeitos temporais. O Agent pode agrupar até dez mudanças de um mesmo livro. Leia a entrada antes de editar ou excluir para obter sua revisão.
- **Incluir no contexto deste chat** acrescenta o livro à seleção normal de World Info. As chaves, filtros e orçamento do Tavern continuam valendo. Para os livros incluídos pelo Mestre, o Agent pode retirá-los da próxima cena. Os vínculos nativos do Tavern também participam da seleção conforme a configuração do app. [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- Os livros são arquivos nativos compartilháveis. Se o mesmo livro for usado em várias conversas, uma edição nele aparece em todas. Use um livro dedicado para registrar acontecimentos exclusivos de uma campanha.
- Dentro de uma execução já iniciada, use **mestre_lore** para consultar a versão recém-editada. O Agent nativo captura o World Info no início da execução e usa esse contexto para a geração. [Montagem do contexto do Agent](https://github.com/Darkatse/TauriTavern/blob/v2.4.0/docs/Agent/PromptAssembly.md)

## Caderno

Cada conversa tem seu próprio caderno. Mantenha **Local**, **Quando**, **Presentes**, um resumo da cena e **Em jogo agora**. Escreva fatos confirmados, perfis de NPCs, tramas abertas, segredos e rascunhos. Uma trama pode ter um relógio, como **1/4** para a aproximação de uma patrulha. O Agent pode avançar o relógio e usar o resultado para decidir o que acontece na ficção.

O prompt recebe um resumo compacto da cena e das tramas abertas. O Agent consulta as demais notas quando precisa delas. Registre segredos como notas do Mestre quando quiser mantê-los disponíveis sob demanda.

O **Histórico** registra mudanças do jogador e do Agent. **Desfazer** recupera campos do caderno ou entradas de Lorebook enquanto a revisão permitir. O histórico guarda até 100 mudanças recentes, com até 20 restaurações conforme o tamanho dos dados. Se a gravação do arquivo for concluída antes do registro, **Conferir gravação** verifica o que foi salvo.

## Ferramentas

| Ferramenta | Uso |
| --- | --- |
| **mestre_context** | Consultar cena e tramas ou buscar e ler notas. |
| **mestre_notebook** | Escrever notas, atualizar a cena ou avançar um relógio. |
| **mestre_lore** | Listar livros acessíveis, buscar entradas ou ler uma entrada e sua revisão. |
| **mestre_create_book** | Criar um livro nativo com entradas iniciais opcionais. |
| **mestre_edit_lore** | Adicionar, editar, ativar, desativar ou excluir entradas. |
| **mestre_use_book** | Incluir ou retirar um livro do contexto extra do Mestre nesta conversa. |

Para experimentar, envie **“Você é o mestre desta aventura. Abra a cena no cais da cidade. Registre no caderno quem está presente e abra uma trama para o farol apagado, com relógio 0/4. Crie um Lorebook chamado Costa da Névoa, com uma entrada sobre o farol. Use o World Info e o caderno para dar continuidade às próximas cenas.”**

## Verificação

Use **npm test** com Node.js 22 ou posterior. **npm run test:browser** usa Playwright e Chromium. O teste **test/native.mjs** usa uma cópia portátil descartável do TauriTavern via CDP e cria arquivos de World Info nessa cópia. O pacote de instalação contém apenas os arquivos da extensão.
